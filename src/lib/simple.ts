import { z } from 'zod';
import { db } from './db';
import { AppError, audit, encrypt, opaqueToken, safeUser } from './security';
import { enqueue, transaction } from './engine';
import { inspectPublicSpreadsheet } from './public-sheets';
import { phoneSchema } from './validation';
import { SIMPLE_TEMPLATE, spreadsheetIdentity } from './simple-shared';
import type { User } from '@/generated/mongo';
import { backgroundWhatsApp, nativeWhatsAppLogin } from './whatsapp-native';
import { feedbackBaseURL } from './feedback-url';
import { LEGACY_ORGANIZATION } from './organizations';

export const simpleSender=(organizationId:string)=>db.sender.findFirst({where:{organizationId,provider:'WEB'},orderBy:{createdAt:'asc'}});
const sheetWhere={connectionType:{startsWith:'SIMPLE_'}};
const recipientSchema=z.object({name:z.string().trim().min(1).max(100),phone:phoneSchema});
async function sheetById(id:string,organizationId:string) {
  const sheet=await db.sheet.findFirst({where:{id,organizationId,...sheetWhere},include:{rule:true}});
  if(!sheet)throw new AppError(404,'Sheet not found');return sheet;
}
export async function simpleAction(path:string[],method:string,request:Request,user:User) {
  if(user.role!=='SUPER_ADMIN')throw new AppError(403,'Sign in with the administrator account to connect sheets and WhatsApp.');
  const organizationId=user.organizationId;
  const route=path.join('/');
  const input=async()=>{if(Number(request.headers.get('content-length')||0)>100000)throw new AppError(413,'Request is too large');return request.json();};
  if(route==='state'&&method==='GET'){
    const [account,sheets,worker,organization]=await Promise.all([simpleSender(organizationId),db.sheet.findMany({where:{...sheetWhere,organizationId},orderBy:{createdAt:'asc'},include:{rule:{include:{recipients:{orderBy:{position:'asc'},include:{employee:{select:{name:true,phone:true}}}}}},_count:{select:{leads:true}}}}),db.setting.findUnique({where:{key:'simple:worker'}}),db.organization.findUniqueOrThrow({where:{id:organizationId},select:{id:true,name:true}})]);
    const summaries=await Promise.all(sheets.map(async s=>{
      const [counts,failure]=await Promise.all([db.message.groupBy({by:['status'],where:{lead:{sheetId:s.id}},_count:true}),db.message.findFirst({where:{lead:{sheetId:s.id},status:'FAILED'},orderBy:{failedAt:'desc'},select:{failureReason:true}})]);
      const total=(statuses:string[])=>counts.filter(c=>statuses.includes(c.status)).reduce((sum,c)=>sum+c._count,0);
      return {id:s.id,name:s.name,worksheetName:s.worksheetName,lastSyncAt:s.lastSyncAt,lastSyncError:s.lastSyncError,leadCount:s._count.leads,enabled:s.rule?.enabled||false,recipients:s.rule?.recipients.map(r=>r.employee)||[],delivery:{submitted:total(['SUBMITTED','SENT','DELIVERED','READ']),queued:total(['QUEUED','PROCESSING']),failed:total(['FAILED']),error:failure?.failureReason||null}};
    }));
    let feedbackError:string|null=null;try{await feedbackBaseURL(db,true);}catch(error){if(error instanceof AppError)feedbackError=error.message;else throw error;}
    return {user:safeUser(user),organization,feedbackError,whatsappLoginMode:backgroundWhatsApp()?'background':nativeWhatsAppLogin()?'browser':'qr',account:account?{id:account.id,phone:account.phone,status:account.status,qrCode:nativeWhatsAppLogin()&&!backgroundWhatsApp()?null:account.qrCode,lastError:account.lastError}:null,sheets:summaries,workerRunning:!!worker&&Date.now()-Number((worker.value as {at:number}).at)<30000};
  }
  if(route==='google'&&method==='GET'){
    const credentials=await db.googleCredential.findMany({where:{organizationId},select:{id:true,label:true,type:true},orderBy:{createdAt:'desc'}});
    const serviceAccountConfigured=organizationId===LEGACY_ORGANIZATION&&!!process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
    let email:string|undefined;try{if(serviceAccountConfigured)email=JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64!, 'base64').toString()).client_email;}catch{}
    return {credentials,serviceAccountEmail:email,serviceAccountConfigured,oauthConfigured:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET)};
  }
  if(route==='google/key'&&method==='POST'){
    const data=z.object({client_email:z.email(),private_key:z.string().min(100),type:z.literal('service_account'),project_id:z.string().optional(),private_key_id:z.string().optional()}).parse(await input());
    const credential=await db.googleCredential.create({data:{organizationId,label:data.client_email,type:'SERVICE_ACCOUNT',encryptedValue:encrypt(JSON.stringify(data))}});
    await audit(user.id,'CONNECT_GOOGLE','integration');return {id:credential.id,label:credential.label,type:credential.type};
  }
  if(route==='whatsapp/connect'&&method==='POST'){
    const id=`smartlead-web-${organizationId}`;
    const account=await simpleSender(organizationId)||await db.sender.upsert({where:{id},create:{id,organizationId,name:'My WhatsApp',provider:'WEB'},update:{}});
    if(!nativeWhatsAppLogin()&&account.status==='CONNECTED')return {connecting:false};
    if(!nativeWhatsAppLogin()&&account.status==='WAITING_QR'&&account.qrCode)return {connecting:true};
    if(!nativeWhatsAppLogin()&&account.status!=='CONNECTED')await db.sender.update({where:{id:account.id},data:{status:'CONNECTING',lastError:null,qrCode:null}});
    await enqueue(db,'CONNECT',account.id,`simple:connect:${account.id}:${Math.floor(Date.now()/10000)}`);return {connecting:true};
  }
  if(route==='whatsapp/disconnect'&&method==='POST'){
    const account=await simpleSender(organizationId);if(!account)return {disconnected:true};
    await enqueue(db,'DISCONNECT',account.id,`simple:disconnect:${account.id}:${opaqueToken()}`);return {disconnected:true};
  }
  if(route==='contacts'&&method==='GET'){
    const account=await simpleSender(organizationId);if(account?.status!=='CONNECTED')return {contacts:[],updatedAt:null};
    const cache=await db.setting.findUnique({where:{key:`whatsapp-contacts:${account.id}`}});return cache?.value||{contacts:[],updatedAt:null};
  }
  if(route==='contacts/refresh'&&method==='POST'){
    const account=await simpleSender(organizationId);if(account?.status!=='CONNECTED')throw new AppError(409,'Connect WhatsApp first.');
    await enqueue(db,'CONTACTS',account.id,`simple:contacts:${account.id}:${Math.floor(Date.now()/10000)}`);return {refreshing:true};
  }
  if(route==='sheets/inspect'&&method==='POST'){
    const data=z.object({url:z.string().max(500)}).parse(await input());
    let identity:ReturnType<typeof spreadsheetIdentity>;try{identity=spreadsheetIdentity(data.url);}catch(e){throw new AppError(400,(e as Error).message);}
    return {...await inspectPublicSpreadsheet(identity.id,identity.gid),spreadsheetId:identity.id,gid:identity.gid};
  }
  if(route==='sheets'&&method==='POST'){
    const data=z.object({spreadsheetId:z.string(),worksheetId:z.number().int().nonnegative(),columnMapping:z.record(z.string(),z.string())}).parse(await input());
    const info=await inspectPublicSpreadsheet(data.spreadsheetId,data.worksheetId);const tab=info.tabs.find(t=>t.id===data.worksheetId);
    if(!tab)throw new AppError(400,'Choose a sheet tab.');
    const allowed=['customerName','mobile','project','email','location','budget','source','requirement','leadDate','leadId'];
    const mapping=Object.fromEntries(Object.entries(data.columnMapping).filter(([k,v])=>allowed.includes(k)&&v));
    if(!mapping.customerName||!mapping.mobile||Object.values(mapping).some(c=>!tab.headers.includes(c))||new Set(Object.values(mapping)).size!==Object.values(mapping).length)throw new AppError(400,'Choose different, valid columns for name and phone.');
    const account=await simpleSender(organizationId);
    const sheet=await db.sheet.create({data:{organizationId,name:info.title,project:info.title,spreadsheetId:data.spreadsheetId,worksheetId:tab.id,worksheetName:tab.name,connectionType:'SIMPLE_PUBLIC',columnMapping:mapping,managedColumnsApproved:false,syncInterval:60,rule:{create:{mode:'ROUND_ROBIN',enabled:false,senderId:account?.id,template:SIMPLE_TEMPLATE}}}});
    await audit(user.id,'CONNECT_SHEET','sheet',sheet.id);return {id:sheet.id};
  }
  if(path[0]==='sheets'&&path[1]&&path[2]==='recipients'&&method==='PUT'){
    const sheet=await sheetById(path[1],organizationId);
    const {recipients}=z.object({recipients:z.array(recipientSchema).min(1,'Select at least one person.').max(100)}).parse(await input());
    if(new Set(recipients.map(r=>r.phone)).size!==recipients.length)throw new AppError(400,'Select each phone number only once.');
    const account=await simpleSender(organizationId);if(account?.status!=='CONNECTED')throw new AppError(409,'Connect WhatsApp before starting.');
    await transaction(async tx=>{
      const previous=await tx.ruleRecipient.findMany({where:{ruleId:sheet.rule!.id},orderBy:{position:'asc'},include:{employee:{select:{phone:true}}}});
      const changed=previous.length!==recipients.length||previous.some((r,i)=>r.employee.phone!==recipients[i].phone);
      const employees=[];
      for(const person of recipients)employees.push(await tx.employee.upsert({where:{organizationId_phone:{organizationId,phone:person.phone}},create:{...person,organizationId,projects:[],dailyLimit:1000,capacity:10000},update:{active:true,name:person.name}}));
      if(changed){
        // Rebuild only leads that have never reached the provider. Otherwise a
        // batch assigned before adding people would keep going to the old list.
        const pending=await tx.message.findMany({where:{status:'QUEUED',lead:{sheetId:sheet.id},OR:[{recipient:{notIn:recipients.map(r=>r.phone)}},{lead:{messages:{none:{OR:[{status:{in:['PROCESSING','SUBMITTED','SENT','DELIVERED','READ']}},{status:'FAILED',uncertain:true}]}}}}]},select:{assignmentId:true}});
        if(pending.length){
          await tx.message.updateMany({where:{assignmentId:{in:pending.map(m=>m.assignmentId)},status:'QUEUED'},data:{status:'CANCELLED',failureReason:'Recipient selection changed before sending'}});
          await tx.assignment.updateMany({where:{id:{in:pending.map(m=>m.assignmentId)}},data:{active:false}});
        }
      }
      await tx.ruleRecipient.deleteMany({where:{ruleId:sheet.rule!.id}});
      await tx.distributionRule.update({where:{id:sheet.rule!.id},data:{mode:'ROUND_ROBIN',senderId:account.id,enabled:true,template:SIMPLE_TEMPLATE,...(changed?{cursor:0}:{}),recipients:{create:employees.map((e,position)=>({employeeId:e.id,position}))}}});
      const unassigned=await tx.lead.findMany({where:{sheetId:sheet.id,sourceDeleted:false,assignments:{none:{active:true}}},select:{id:true},orderBy:{sourceRow:'asc'}});
      for(const lead of unassigned)await enqueue(tx,'ASSIGN',lead.id,`simple:assign:${lead.id}:${opaqueToken()}`);
      await enqueue(tx,'SYNC',sheet.id,`simple:sync:${sheet.id}:${opaqueToken()}`);
      const queued=await tx.message.findMany({where:{lead:{sheetId:sheet.id},status:'QUEUED'},select:{id:true}});
      await tx.job.updateMany({where:{type:'SEND',status:'PENDING',entityId:{in:queued.map(m=>m.id)}},data:{runAt:new Date()}});
    });
    await audit(user.id,'START_AUTOMATIC_SENDING','sheet',sheet.id);return {started:true};
  }
  if(path[0]==='sheets'&&path[1]&&path[2]==='pause'&&method==='PUT'){
    const sheet=await sheetById(path[1],organizationId);const {enabled}=z.object({enabled:z.boolean()}).parse(await input());
    const rule=await db.distributionRule.findUniqueOrThrow({where:{sheetId:sheet.id},include:{recipients:true}});
    if(enabled&&!rule.recipients.length)throw new AppError(400,'Choose recipients first.');
    await db.distributionRule.update({where:{id:rule.id},data:{enabled}});
    if(enabled){
      const leads=await db.lead.findMany({where:{sheetId:sheet.id,sourceDeleted:false,assignments:{none:{active:true}}},select:{id:true},orderBy:{sourceRow:'asc'}});
      for(const lead of leads)await enqueue(db,'ASSIGN',lead.id,`simple:resume:${lead.id}:${opaqueToken()}`);
      await enqueue(db,'SYNC',sheet.id,`simple:resume-sync:${sheet.id}:${opaqueToken()}`);
      const queued=await db.message.findMany({where:{lead:{sheetId:sheet.id},status:'QUEUED'},select:{id:true}});
      await db.job.updateMany({where:{type:'SEND',status:'PENDING',entityId:{in:queued.map(m=>m.id)}},data:{runAt:new Date()}});
    }
    return {enabled};
  }
  throw new AppError(404,'Page not found');
}
