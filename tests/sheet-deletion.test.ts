import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { simpleAction } from '@/lib/simple';
import { registerOrganization } from '@/lib/organizations';
import { clearTestModels } from './database-fixture';
import { dispatchMessage, processJob, synchronizeSheet, writebackLead } from '@/lib/engine';
import { dispatchLeadSentNotification } from '@/lib/lead-sent-notifications';
import { encrypt } from '@/lib/security';
import type { SheetProvider, SourceRow } from '@/lib/google';
import type { WhatsAppProvider } from '@/lib/whatsapp';

beforeEach(async()=>{
  vi.restoreAllMocks();
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.deleteMany({where:{id:{not:'legacy'}}});
});
afterAll(()=>db.$disconnect());

async function fixture(){
  const owner=await registerOrganization({name:'Owner',organizationName:'Agency',phone:'9876543210',pin:'4826'});
  const other=await registerOrganization({name:'Other Owner',organizationName:'Other Agency',phone:'9876543211',pin:'4826'});
  const sender=await db.sender.create({data:{organizationId:owner.organizationId,name:'WhatsApp',provider:'WEB',status:'CONNECTED'}});
  const employee=await db.employee.create({data:{organizationId:owner.organizationId,name:'Recipient',phone:'+919876543212',projects:[]}});
  const makeSheet=(organizationId:string,name:string)=>db.sheet.create({data:{organizationId,name,project:name,spreadsheetId:name,connectionType:'SIMPLE_PUBLIC',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{template:'A lead',enabled:true,recipients:organizationId===owner.organizationId?{create:{employeeId:employee.id}}:undefined}}}});
  const sheet=await makeSheet(owner.organizationId,'Delete me');
  const keep=await makeSheet(owner.organizationId,'Keep me');
  const foreign=await makeSheet(other.organizationId,'Other agency sheet');
  const lead=await db.lead.create({data:{sheetId:sheet.id,stableSourceId:'source',sourceRow:2,sourceFingerprint:'fingerprint',customerName:'Customer',mobile:'+919876543213',project:'Test'}});
  const assignment=await db.assignment.create({data:{leadId:lead.id,employeeId:employee.id}});
  await db.feedbackToken.create({data:{assignmentId:assignment.id,tokenHash:'delete-token',expiresAt:new Date(Date.now()+60000)}});
  await db.feedback.create({data:{leadId:lead.id,assignmentId:assignment.id,employeeId:employee.id,status:'New',remarks:'Feedback'}});
  await db.followup.create({data:{leadId:lead.id,employeeId:employee.id,scheduledAt:new Date()}});
  const message=await db.message.create({data:{leadId:lead.id,assignmentId:assignment.id,senderId:sender.id,idempotencyKey:'delete-message',recipient:employee.phone,encryptedBody:encrypt('A lead')}});
  for(const [type,entityId]of [['SYNC',sheet.id],['ASSIGN',lead.id],['WRITEBACK',lead.id],['SEND',message.id],['NOTIFY',message.id],['SYNC',keep.id],['CONNECT',sender.id]]){
    await db.job.create({data:{organizationId:owner.organizationId,key:`${type}:${entityId}`,type,entityId}});
  }
  await db.sheetAccess.create({data:{sheetId:sheet.id,userId:owner.id}});
  await db.syncLog.create({data:{sheetId:sheet.id,operation:'IMPORT',status:'SUCCESS',details:'Imported'}});
  for(const key of [`statuses:${sheet.id}`,`demo-source:${sheet.id}`,'unrelated-setting'])await db.setting.create({data:{key,value:[]}});
  return {owner,other,sheet,keep,foreign,sender,employee,lead,assignment,message};
}
const remove=(user:Awaited<ReturnType<typeof fixture>>['owner'],id:string)=>simpleAction(['sheets',id],'DELETE',new Request('http://localhost/api/simple/sheets/'+id,{method:'DELETE'}),user);
function gate(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return {promise,open};}
async function expectRemoved(f:Awaited<ReturnType<typeof fixture>>){
  expect(await db.sheet.findUnique({where:{id:f.sheet.id}})).toBeNull();
  expect(await Promise.all([db.lead.count(),db.assignment.count(),db.message.count(),db.feedbackToken.count(),db.feedback.count(),db.followup.count(),db.syncLog.count()])).toEqual(Array(7).fill(0));
  expect((await db.job.findMany()).map(job=>job.type).sort()).toEqual(['CONNECT','SYNC']);
  expect(await db.sheet.count()).toBe(2);
}

describe('delete connected sheets',()=>{
  it('removes dependent history and queued jobs atomically, preserving other sheets, shared accounts, and the Google source',async()=>{
    const f=await fixture();const network=vi.spyOn(globalThis,'fetch');
    expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});
    expect(await Promise.all([db.lead.count(),db.assignment.count(),db.feedbackToken.count(),db.feedback.count(),db.followup.count(),db.message.count(),db.sheetAccess.count(),db.syncLog.count()])).toEqual(Array(8).fill(0));
    expect(await db.sheet.findMany({select:{id:true}})).toEqual(expect.arrayContaining([{id:f.keep.id},{id:f.foreign.id}]));
    expect(await db.sheet.count()).toBe(2);expect(await db.distributionRule.count()).toBe(2);expect(await db.ruleRecipient.count()).toBe(1);
    expect(await db.employee.findUnique({where:{id:f.employee.id}})).not.toBeNull();expect(await db.sender.findUnique({where:{id:f.sender.id}})).not.toBeNull();
    expect((await db.job.findMany()).map(job=>job.type).sort()).toEqual(['CONNECT','SYNC']);
    expect((await db.setting.findMany()).map(setting=>setting.key)).toEqual(['unrelated-setting']);
    expect(await db.auditLog.findFirst({where:{action:'DELETE_SHEET'}})).toMatchObject({userId:f.owner.id,entityId:f.sheet.id});
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects administrators of other organisations and non-admin users',async()=>{
    const f=await fixture();
    await expect(remove(f.other,f.sheet.id)).rejects.toMatchObject({status:404});
    for(const role of ['MANAGER','EXECUTIVE'])await expect(remove({...f.owner,role},f.sheet.id)).rejects.toMatchObject({status:403});
    expect(await db.sheet.count()).toBe(3);expect(await db.message.count()).toBe(1);
  });
  it.each(['SYNC','ASSIGN','WRITEBACK','SEND','NOTIFY'])('deletes immediately while a %s job is running',async type=>{
    const f=await fixture();
    const entityId=type==='SYNC'?f.sheet.id:['SEND','NOTIFY'].includes(type)?f.message.id:f.lead.id;
    await db.job.updateMany({where:{type,entityId},data:{status:'PROCESSING',lockedAt:new Date(),lockToken:'active-job'}});
    expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});
    await expectRemoved(f);
  });
  it.each(['lead','owner','executive'])('deletes immediately while a %s message submission is in progress',async stage=>{
    const f=await fixture();await db.message.update({where:{id:f.message.id},data:stage==='lead'?{status:'PROCESSING'}:stage==='owner'?{notificationStatus:'PROCESSING'}:{notificationStatus:'PROCESSING',executiveNotificationStatus:'PROCESSING'}});
    expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});await expectRemoved(f);
  });
  it('deletes an empty connection and returns not found for a repeat or unknown ID',async()=>{
    const f=await fixture();expect(await remove(f.owner,f.keep.id)).toEqual({deleted:true});
    await expect(remove(f.owner,f.keep.id)).rejects.toMatchObject({status:404});
    await expect(remove(f.owner,'unknown')).rejects.toMatchObject({status:404});
    expect(await db.sheet.count()).toBe(2);
  });
  it('does not import leads or recreate jobs after an active source read finishes late',async()=>{
    const f=await fixture();const read=gate();const started=gate();
    const rows:SourceRow[]=[{stableId:'late-import',row:2,values:{customerName:'Late customer',mobile:'+919876543214'}}];
    const source:SheetProvider={read:vi.fn(async()=>{started.open();await read.promise;return rows;}),write:vi.fn()};
    const pending=synchronizeSheet(f.sheet.id,source);
    try{await started.promise;expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});await expectRemoved(f);}
    finally{read.open();await pending;}
    await expectRemoved(f);expect(source.write).not.toHaveBeenCalled();
  });
  it('does not create follow-up jobs when a message already handed to WhatsApp returns after deletion',async()=>{
    const f=await fixture();await db.sheet.update({where:{id:f.sheet.id},data:{sendFeedbackLink:false}});
    const accepted=gate();const started=gate();
    const send=vi.fn<WhatsAppProvider['sendMessage']>(async()=>{started.open();await accepted.promise;return {id:'already-submitting',status:'SUBMITTED'};});
    const pending=dispatchMessage(f.message.id,{sendMessage:send} as unknown as WhatsAppProvider);
    try{await started.promise;expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});await expectRemoved(f);}
    finally{accepted.open();await pending;}
    await expectRemoved(f);expect(send).toHaveBeenCalledOnce();
    await dispatchMessage(f.message.id,{sendMessage:send} as unknown as WhatsAppProvider);expect(send).toHaveBeenCalledOnce();
  });
  it('does not restore lead history or logs after an active sheet write finishes late',async()=>{
    const f=await fixture();const write=gate();const started=gate();
    const source:SheetProvider={read:vi.fn(),write:vi.fn(async()=>{started.open();await write.promise;})};
    const pending=writebackLead(f.lead.id,source);
    try{await started.promise;expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});await expectRemoved(f);}
    finally{write.open();await pending;}
    await expectRemoved(f);expect(source.write).toHaveBeenCalledOnce();
  });
  it.each([1,2])('cancels notifications when deleted during throttle before stage %s',async blockedStage=>{
    const f=await fixture();
    await db.message.update({where:{id:f.message.id},data:{status:'SUBMITTED',notificationStatus:'QUEUED',notificationPhone:'+919876543218',notificationName:f.employee.name,executiveNotificationPhone:'+919876543217',executiveNotificationStatus:'QUEUED'}});
    const waiting=gate();const started=gate();let stage=0;
    const send=vi.fn<WhatsAppProvider['sendMessage']>(async()=>({id:`receipt-${crypto.randomUUID()}`,status:'SUBMITTED'}));
    const pending=dispatchLeadSentNotification(f.message.id,{sendMessage:send} as unknown as WhatsAppProvider,async()=>{if(++stage===blockedStage){started.open();await waiting.promise;}});
    try{await started.promise;expect(send).toHaveBeenCalledTimes(blockedStage-1);expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});await expectRemoved(f);}
    finally{waiting.open();await pending;}
    expect(send).toHaveBeenCalledTimes(blockedStage-1);await expectRemoved(f);
  });
  it('does not send the owner notification after a late executive receipt returns for a deleted sheet',async()=>{
    const f=await fixture();
    await db.message.update({where:{id:f.message.id},data:{status:'SUBMITTED',notificationStatus:'QUEUED',notificationPhone:'+919876543218',notificationName:f.employee.name,executiveNotificationPhone:'+919876543217',executiveNotificationStatus:'QUEUED'}});
    const receipt=gate();const started=gate();
    const send=vi.fn<WhatsAppProvider['sendMessage']>(async()=>{started.open();await receipt.promise;return {id:'executive-submitting',status:'SUBMITTED'};});
    const pending=dispatchLeadSentNotification(f.message.id,{sendMessage:send} as unknown as WhatsAppProvider);
    try{await started.promise;expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});await expectRemoved(f);}
    finally{receipt.open();await pending;}
    expect(send).toHaveBeenCalledOnce();await expectRemoved(f);
  });
  it('ignores a selected or directly requested worker job after its sheet is deleted',async()=>{
    const f=await fixture();const candidate=await db.job.findFirstOrThrow({where:{type:'SYNC',entityId:f.sheet.id}});
    await remove(f.owner,f.sheet.id);
    expect(await processJob(candidate.id,candidate)).toBe(false);expect(await processJob(candidate.id)).toBe(false);await expectRemoved(f);
  });
});
