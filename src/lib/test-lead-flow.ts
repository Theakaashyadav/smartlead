import { z } from 'zod';
import type { Prisma } from '@/generated/mongo';
import { db, databaseTransaction } from './db';
import { isDemo } from './config';
import { AppError, hash, opaqueToken } from './security';
import { phoneSchema } from './validation';
import { requireWhatsAppWorker, workerHeartbeatFresh, workerOfflineMessage } from './worker-status';
import { UncertainDelivery, whatsappProvider, type WhatsAppProvider } from './whatsapp';
import { leadSentNotificationMessage } from './simple-shared';

export type TestLeadFlowStage = {
  status:'WAITING'|'PROCESSING'|'SUBMITTED'|'FAILED'|'UNCERTAIN';
  providerMessageId?:string;
  error?:string;
  lastAttemptAt?:string;
};
export type TestLeadFlow = {
  id:string;
  status:'QUEUED'|'RUNNING'|'COMPLETED'|'FAILED'|'UNCERTAIN';
  recipients:Array<{name:string;phone:string;lead:TestLeadFlowStage;executive:TestLeadFlowStage;owner:TestLeadFlowStage}>;
  executiveNotificationPhone:string;
  notificationPhone:string;
  error:string|null;
  workerMessage:string|null;
  createdAt:string;
  updatedAt:string;
};
type StoredFlow=Omit<TestLeadFlow,'workerMessage'>&{senderId:string;payloadHash:string;claimToken?:string;claimedAt?:string};
const schema=z.object({
  requestId:z.uuid(),
  recipients:z.array(z.object({name:z.string().trim().min(1).max(100).transform(value=>value.replace(/[\r\n]+/g,' ')),phone:phoneSchema})).min(1,'Choose at least one test recipient.').max(10,'Choose up to 10 test recipients.'),
  executiveNotificationPhone:phoneSchema,
  notificationPhone:phoneSchema,
});
const keyFor=(organizationId:string,id:string)=>`test-lead-flow:${organizationId}:${id}`;
const json=(value:StoredFlow)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const terminal=(run:StoredFlow)=>['COMPLETED','FAILED','UNCERTAIN'].includes(run.status);
const stale=(run:StoredFlow)=>Date.now()-Date.parse(run.claimedAt||run.updatedAt)>=5*60000;
async function storedFlow(organizationId:string,id:string){
  if(!z.uuid().safeParse(id).success)throw new AppError(404,'Test flow not found.');
  const record=await db.setting.findUnique({where:{key:keyFor(organizationId,id)}});
  if(!record)throw new AppError(404,'Test flow not found.');
  return record.value as unknown as StoredFlow;
}
async function publicFlow(run:StoredFlow):Promise<TestLeadFlow>{
  const {senderId:_,payloadHash:__,claimToken:___,claimedAt:____,...result}=run;
  const heartbeat=await db.setting.findUnique({where:{key:'simple:worker'}});
  return {...result,workerMessage:!terminal(run)&&!isDemo()&&!workerHeartbeatFresh(heartbeat?.value)?workerOfflineMessage():null};
}
export async function getTestLeadFlow(organizationId:string,id:string){return publicFlow(await storedFlow(organizationId,id));}

export async function createTestLeadFlow(organizationId:string,input:unknown){
  const data=schema.parse(input);
  if(new Set(data.recipients.map(person=>person.phone)).size!==data.recipients.length)throw new AppError(400,'Select each test recipient only once.');
  const {requestId:id,...targets}=data;
  const payloadHash=hash(JSON.stringify(targets));
  const key=keyFor(organizationId,id);
  const existing=await db.setting.findUnique({where:{key}});
  if(existing){
    const run=existing.value as unknown as StoredFlow;
    if(run.payloadHash!==payloadHash)throw new AppError(409,'This test has already started with different numbers. Start a new test to change them.');
    return publicFlow(run);
  }
  const sender=await db.sender.findFirst({where:{organizationId,provider:'WEB'},orderBy:{createdAt:'asc'}});
  if(sender?.status!=='CONNECTED')throw new AppError(409,'Connect WhatsApp before sending a test lead.','DISCONNECTED');
  if(!isDemo())await requireWhatsAppWorker();
  const now=new Date().toISOString();
  const run:StoredFlow={id,senderId:sender.id,payloadHash,status:'QUEUED',recipients:data.recipients.map(person=>({...person,lead:{status:'WAITING'},executive:{status:'WAITING'},owner:{status:'WAITING'}})),executiveNotificationPhone:data.executiveNotificationPhone,notificationPhone:data.notificationPhone,error:null,createdAt:now,updatedAt:now};
  try{
    await databaseTransaction(async tx=>{
      await tx.setting.create({data:{key,value:json(run)}});
      await tx.job.create({data:{key,type:'TEST_FLOW',entityId:id,organizationId}});
    });
  }catch(error){
    // Concurrent copies of the same request share one durable job, even when
    // the first response was lost and the browser submits it again.
    const winner=await db.setting.findUnique({where:{key}});
    if(!winner)throw error;
    const saved=winner.value as unknown as StoredFlow;
    if(saved.payloadHash!==payloadHash)throw new AppError(409,'This test has already started with different numbers. Start a new test to change them.');
    return publicFlow(saved);
  }
  return publicFlow(run);
}

const testLeadBody='[TEST]\nHello, You got a new lead\nProject – *SmartLead Test*\nHere\'s what we know:\nName: *SmartLead Test Lead*\nPhone: *0000000000*\nCity: *Test City*\nThis is a sample lead. No call or feedback is needed.\nThank you!';
class LostFlowClaim extends Error{}

export async function dispatchTestLeadFlow(id:string,organizationId:string,providerOverride?:WhatsAppProvider,beforeSend?:()=>Promise<void>,jobClaimToken?:string){
  let run=await storedFlow(organizationId,id);
  if(terminal(run))return;
  const key=keyFor(organizationId,id);
  const save=async(next:StoredFlow)=>{
    next.updatedAt=new Date().toISOString();
    const saved=await db.setting.updateMany({where:{key,value:{equals:json(run)}},data:{value:json(next)}});
    if(!saved.count)throw new LostFlowClaim();
    run=next;
  };
  try{
    if(run.status==='RUNNING'){
      // A fresh claim belongs to another dispatcher. A stale submission could
      // have reached WhatsApp; keep it for review instead of sending it twice.
      const ownsJob=jobClaimToken&&await db.job.findFirst({where:{type:'TEST_FLOW',entityId:id,organizationId,status:'PROCESSING',lockToken:jobClaimToken},select:{id:true}});
      if(!stale(run)&&!ownsJob)return;
      const interrupted=run.recipients.flatMap(person=>[person.lead,person.executive,person.owner]).find(stage=>stage.status==='PROCESSING');
      if(interrupted){
        const next=structuredClone(run);
        const stage=next.recipients.flatMap(person=>[person.lead,person.executive,person.owner]).find(stage=>stage.status==='PROCESSING')!;
        stage.status='UNCERTAIN';stage.error='The worker stopped during submission. Check the linked WhatsApp account before starting another test.';
        next.status='UNCERTAIN';next.error=stage.error;await save(next);return;
      }
    }
    const sender=await db.sender.findUnique({where:{id:run.senderId}});
    if(!sender||sender.organizationId!==organizationId||sender.provider!=='WEB'){
      await save({...run,status:'FAILED',error:'The test WhatsApp connection is no longer available. Start a new test with your current connection.'});return;
    }
    if(sender.status!=='CONNECTED'){
      await save({...run,status:'QUEUED',error:'WhatsApp disconnected. The test will continue after reconnection.'});
      throw new AppError(409,'WhatsApp disconnected; the test remains queued.','DISCONNECTED');
    }
    await save({...run,status:'RUNNING',error:null,claimToken:jobClaimToken||opaqueToken(),claimedAt:new Date().toISOString()});
    const provider=providerOverride||whatsappProvider(sender);
    for(let index=0;index<run.recipients.length;index++){
      for(const kind of ['lead','executive','owner'] as const){
        const person=run.recipients[index];
        if(person[kind].status==='SUBMITTED')continue;
        // Throttling happens before PROCESSING is recorded: no WhatsApp send
        // can have started if the worker stops while waiting for its turn.
        await beforeSend?.();
        let next=structuredClone(run);
        next.recipients[index][kind]={status:'PROCESSING',lastAttemptAt:new Date().toISOString()};
        next.claimedAt=new Date().toISOString();await save(next);
        const to=kind==='lead'?person.phone:kind==='executive'?run.executiveNotificationPhone:run.notificationPhone;
        const body=kind==='lead'?testLeadBody:`[TEST]\n${leadSentNotificationMessage({leadName:'SmartLead Test Lead',recipientName:person.name,...(kind==='owner'?{phone:'0000000000',executiveUpdated:true}:{})})}`;
        try{
          // Test submissions have no real Message/Lead record. The stage receipt
          // below supplies their independent durable submission history.
          const result=await provider.sendMessage({to,body,parameters:[]});
          if(!result.id)throw new UncertainDelivery('WhatsApp returned no submission identifier.');
          next=structuredClone(run);next.recipients[index][kind]={...next.recipients[index][kind],status:'SUBMITTED',providerMessageId:result.id};
          next.claimedAt=new Date().toISOString();await save(next);
        }catch(error){
          if(error instanceof LostFlowClaim)return;
          const disconnected=error instanceof AppError&&error.code==='DISCONNECTED';
          const uncertain=error instanceof UncertainDelivery||!(error instanceof AppError);
          const label=kind==='lead'?`Lead to ${person.name}`:kind==='executive'?`Executive notification for ${person.name}`:`Your notification for ${person.name}`;
          const reason=uncertain?`${label}: WhatsApp acceptance is uncertain. Check the linked account before starting another test.`:`${label}: ${(error as Error).message}`;
          next=structuredClone(run);
          next.recipients[index][kind]={...next.recipients[index][kind],status:disconnected?'WAITING':uncertain?'UNCERTAIN':'FAILED',error:reason};
          next.status=disconnected?'QUEUED':uncertain?'UNCERTAIN':'FAILED';next.error=reason;await save(next);
          if(disconnected)throw error;
          return;
        }
      }
    }
    await save({...run,status:'COMPLETED',error:null});
  }catch(error){if(!(error instanceof LostFlowClaim))throw error;}
}
