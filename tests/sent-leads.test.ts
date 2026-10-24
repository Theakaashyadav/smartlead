import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '@/lib/db';
import {assignLead,dispatchMessage,drainJobs,saveFeedback,synchronizeSheet,writebackLead} from '@/lib/engine';
import {AppError} from '@/lib/security';
import {clearTestModels} from './database-fixture';
import type {SheetProvider,SourceRow} from '@/lib/google';
import type {WhatsAppProvider} from '@/lib/whatsapp';
import {simpleAction} from '@/lib/simple';
import {dispatchLeadSentNotification} from '@/lib/lead-sent-notifications';
import {queueDeliveryWriteback} from '@/lib/delivery';
import {databaseTransaction} from '@/lib/db';

beforeEach(async()=>{
 await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','Sender','Job','AuditLog','Setting','User']);
 await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Sent policy tests'},update:{}});
 await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(()=>db.$disconnect());
async function fixture(sentStatus=''){
 const sender=await db.sender.create({data:{organizationId:'legacy',name:'Test sender',provider:'DEMO',status:'CONNECTED'}});
 const employee=await db.employee.create({data:{organizationId:'legacy',name:'New recipient',phone:'+919800000001',projects:[]}});
 const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Source leads',project:'Project A',spreadsheetId:'sent-source-123456789012345',connectionType:'SIMPLE_APPS_SCRIPT',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{enabled:true,senderId:sender.id,template:'Lead',recipients:{create:{employeeId:employee.id,position:0}}}}}});
 const rows:SourceRow[]=[{stableId:'source-a',row:2,values:{customerName:'Customer A',mobile:'+919800000002',sentStatus,sharedTo:sentStatus?'Original recipient':''}},{stableId:'source-b',row:3,values:{customerName:'Customer B',mobile:'+919800000003',sentStatus:'',sharedTo:''}}];
 const source:SheetProvider={read:vi.fn(async()=>rows),write:vi.fn<SheetProvider['write']>(async(_sheet,id,_metadata,values)=>{Object.assign(rows.find(row=>row.stableId===id)!.values,values);})};
 const send=vi.fn<WhatsAppProvider['sendMessage']>(async()=>({id:`test-${crypto.randomUUID()}`,status:'SUBMITTED' as const}));const whatsapp={sendMessage:send} as never;
 await synchronizeSheet(sheet.id,source);const lead=await db.lead.findUniqueOrThrow({where:{sheetId_stableSourceId:{sheetId:sheet.id,stableSourceId:'source-a'}}});
 const assign=async()=>{await assignLead(lead.id);return db.message.findFirstOrThrow({where:{leadId:lead.id},orderBy:{queuedAt:'asc'}});};
 return {sender,sheet,employee,rows,source,send,whatsapp,lead,assign};
}
async function recipientSaver(f:Awaited<ReturnType<typeof fixture>>){
 await db.sender.update({where:{id:f.sender.id},data:{provider:'WEB'}});
 const admin=await db.user.create({data:{organizationId:'legacy',name:'Administrator',passwordHash:'unused',role:'SUPER_ADMIN'}});
 return (recipients=[{name:'Updated recipient',phone:'+919800000004'}],notificationPhone?:string)=>simpleAction(['sheets',f.sheet.id,'recipients'],'PUT',new Request('http://localhost/api/simple',{method:'PUT',body:JSON.stringify({recipients,notificationPhone})}),admin,f.source);
}
const assignQueued=()=>drainJobs(30,0,undefined,()=>true,['ASSIGN']);

describe('restart from current sheet status when saving recipients',()=>{
 it.each(['','Not Sent','Pending'])('reopens an imported Sent row changed to %j and skips rows still marked Sent',async status=>{
  const f=await fixture('Sent');const save=await recipientSaver(f);
  f.rows[0].values.sentStatus=status;f.rows[1].values.sentStatus='Sent';
  expect(await save()).toMatchObject({started:true,rechecked:2,requeued:1});
  await assignQueued();
  const messages=await db.message.findMany({where:{status:'QUEUED'},include:{lead:true}});
  expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({recipient:'+919800000004',lead:{stableSourceId:'source-a'}});
  await dispatchMessage(messages[0].id,f.whatsapp,f.source);await writebackLead(f.lead.id,f.source);
  expect(f.rows[0].values).toMatchObject({sentStatus:'Sent',sharedTo:'Updated recipient'});
 });
 it('resends a previously submitted lead to the updated recipient and sends a fresh administrator notification',async()=>{
  const f=await fixture();const save=await recipientSaver(f);
  await db.distributionRule.update({where:{sheetId:f.sheet.id},data:{notificationPhone:'+919876543218'}});
  const old=await f.assign();await dispatchMessage(old.id,f.whatsapp,f.source);await writebackLead(f.lead.id,f.source);
  expect(await db.message.findUniqueOrThrow({where:{id:old.id}})).toMatchObject({status:'SUBMITTED',notificationStatus:'QUEUED'});
  f.rows[1].values.sentStatus='Sent';
  await save();await assignQueued();
  expect(await db.message.count({where:{leadId:f.lead.id,status:'QUEUED'}})).toBe(0);
  f.rows[0].values.sentStatus='';
  await synchronizeSheet(f.sheet.id,f.source);
  expect(await assignLead(f.lead.id,f.employee.id,undefined,true)).toMatchObject({reason:'Already sent'});
  await save();await assignQueued();
  const resend=await db.message.findFirstOrThrow({where:{leadId:f.lead.id,status:'QUEUED'}});
  expect(resend.recipient).toBe('+919800000004');
  expect(await db.message.findUniqueOrThrow({where:{id:old.id}})).toMatchObject({status:'SUBMITTED',notificationStatus:'CANCELLED'});
  expect(await db.feedbackToken.findFirstOrThrow({where:{assignmentId:old.assignmentId}})).toMatchObject({revokedAt:expect.any(Date)});
  await databaseTransaction(tx=>queueDeliveryWriteback(tx,old,'old-receipt-before-resend'));
  await writebackLead(f.lead.id,f.source);
  expect(f.rows[0].values).toMatchObject({sentStatus:'',sharedTo:''});expect(f.send).toHaveBeenCalledOnce();
  await dispatchMessage(resend.id,f.whatsapp,f.source);await writebackLead(f.lead.id,f.source);await dispatchLeadSentNotification(resend.id,f.whatsapp);
  expect(f.send).toHaveBeenCalledTimes(3);
  expect(f.send).toHaveBeenNthCalledWith(2,expect.objectContaining({to:'+919800000004',body:expect.stringContaining('Hello, You got a new lead')}));
  expect(f.send).toHaveBeenNthCalledWith(3,expect.objectContaining({to:'+919876543218',body:'New Lead Sent to (Updated recipient)'}));
  expect(f.rows[0].values).toMatchObject({sentStatus:'Sent',sharedTo:'Updated recipient'});
  await databaseTransaction(tx=>queueDeliveryWriteback(tx,old,'late-old-receipt'));
  await writebackLead(f.lead.id,f.source);await dispatchLeadSentNotification(old.id,f.whatsapp);
  expect(f.rows[0].values.sharedTo).toBe('Updated recipient');expect(f.send).toHaveBeenCalledTimes(3);
  expect(await db.message.count({where:{leadId:f.lead.id,status:'SUBMITTED'}})).toBe(2);
  await save();await assignQueued();expect(await db.message.count({where:{leadId:f.lead.id,status:'QUEUED'}})).toBe(0);
 });
 it('imports new rows and starts with the first unsent row in the latest sheet order',async()=>{
  const f=await fixture('Sent');const save=await recipientSaver(f);
  f.rows[1].values.sentStatus='Sent';
  f.rows.push({stableId:'source-c',row:4,values:{customerName:'Customer C',mobile:'+919800000005',sentStatus:''}},{stableId:'source-d',row:5,values:{customerName:'Customer D',mobile:'+919800000006',sentStatus:''}});
  await save();await assignQueued();
  const messages=await db.message.findMany({where:{status:'QUEUED'},include:{lead:true},orderBy:{lead:{sourceRow:'asc'}}});
  expect(messages.map(message=>message.lead.stableSourceId)).toEqual(['source-c','source-d']);
  const jobs=await db.job.findMany({where:{type:'ASSIGN',status:'COMPLETED'},orderBy:{runAt:'asc'}});
  const ids=messages.map(message=>message.leadId);
  expect(jobs.filter(job=>ids.includes(job.entityId)).slice(-2).map(job=>job.entityId)).toEqual(ids);
 });
 it('preserves recipients and queued sends when the sheet cannot be read',async()=>{
  const f=await fixture();const message=await f.assign();const save=await recipientSaver(f);
  vi.mocked(f.source.read).mockRejectedValue(new AppError(502,'Google temporarily unavailable'));
  await expect(save()).rejects.toThrow('Google temporarily unavailable');
  expect(await db.message.findUniqueOrThrow({where:{id:message.id}})).toMatchObject({status:'QUEUED'});
  expect(await db.ruleRecipient.findFirstOrThrow({where:{rule:{sheetId:f.sheet.id}}})).toMatchObject({employeeId:f.employee.id});
 });
 it('ignores a stale Sent response from an old queued send after recipients are saved',async()=>{
  const f=await fixture();const old=await f.assign();const save=await recipientSaver(f);
  let readStarted!:()=>void,finishRead!:()=>void;
  const started=new Promise<void>(resolve=>{readStarted=resolve;});
  const gate=new Promise<void>(resolve=>{finishRead=resolve;});
  const stale=f.rows.map(row=>({...row,values:{...row.values,sentStatus:'Sent'}}));
  vi.mocked(f.source.read).mockImplementationOnce(async()=>{readStarted();await gate;return stale;});
  const pending=dispatchMessage(old.id,f.whatsapp,f.source);
  try{
   await started;await save();await assignQueued();
  }finally{finishRead();await pending;}
  const current=await db.message.findFirstOrThrow({where:{leadId:f.lead.id,status:'QUEUED'}});
  expect(current.recipient).toBe('+919800000004');expect(f.send).not.toHaveBeenCalled();
  await dispatchMessage(current.id,f.whatsapp,f.source);expect(f.send).toHaveBeenCalledOnce();
 });
 it.each(['send','writeback'])('does not reset a lead during an active %s',async type=>{
  const f=await fixture();const message=await f.assign();const save=await recipientSaver(f);
  if(type==='send')await db.message.update({where:{id:message.id},data:{status:'PROCESSING',lastAttemptAt:new Date()}});
  else await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:f.lead.id,key:'active-write',status:'PROCESSING'}});
  await expect(save()).rejects.toMatchObject({code:'SHEET_BUSY'});
  expect(await db.assignment.findUniqueOrThrow({where:{id:message.assignmentId}})).toMatchObject({active:true});
 });
});
describe('already-sent lead protection',()=>{
 it.each(['Sent',' sent ','SENT'])('stores a %s row without queuing another notification, including after reimport and reorder',async status=>{
  const f=await fixture(status);expect(await db.lead.count()).toBe(2);expect(await db.job.count({where:{type:'ASSIGN',entityId:f.lead.id}})).toBe(0);
  f.rows.reverse();f.rows.forEach((row,index)=>{row.row=index+2;});await synchronizeSheet(f.sheet.id,f.source);
  expect(await assignLead(f.lead.id,f.employee.id,undefined,true)).toEqual({assigned:false,reason:'Already sent'});
  expect(await db.message.count({where:{leadId:f.lead.id}})).toBe(0);expect(await db.lead.count()).toBe(2);
  expect((await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).managedSnapshot).toMatchObject({__sourceSent:'1',sentStatus:status,sharedTo:'Original recipient'});
 });
 it.each(['','Not Sent','Pending'])('still sends an unsent row with status %j',async status=>{
  const f=await fixture(status);const message=await f.assign();await dispatchMessage(message.id,f.whatsapp,f.source);expect(f.send).toHaveBeenCalledOnce();
 });
 it('checks the latest sheet value before sending a message queued before the Sent marker appeared',async()=>{
  const f=await fixture();const message=await f.assign();f.rows[0].values.sentStatus='Sent';f.rows[0].values.sharedTo='Original recipient';
  await dispatchMessage(message.id,f.whatsapp,f.source);expect(f.send).not.toHaveBeenCalled();
  expect(await db.message.findUniqueOrThrow({where:{id:message.id}})).toMatchObject({status:'CANCELLED',attemptCount:0});
  expect(await db.job.findFirst({where:{type:'SEND',entityId:message.id}})).toMatchObject({status:'COMPLETED'});
  f.rows[0].values.sentStatus='';await synchronizeSheet(f.sheet.id,f.source);
  expect(await assignLead(f.lead.id,f.employee.id,undefined,true)).toEqual({assigned:false,reason:'Already sent'});
  await db.message.update({where:{id:message.id},data:{status:'QUEUED'}});await dispatchMessage(message.id,f.whatsapp,f.source);expect(f.send).not.toHaveBeenCalled();
 });
 it('cancels old queued messages when the next import observes Sent',async()=>{
  const f=await fixture();const message=await f.assign();f.rows[0].values.sentStatus='Sent';await synchronizeSheet(f.sheet.id,f.source);
  expect((await db.message.findUniqueOrThrow({where:{id:message.id}})).status).toBe('CANCELLED');await dispatchMessage(message.id,f.whatsapp,f.source);expect(f.send).not.toHaveBeenCalled();
 });
 it('uses confirmed database history even if the Google Sheet update has not completed',async()=>{
  const f=await fixture();const message=await f.assign();await dispatchMessage(message.id,f.whatsapp,f.source);
  expect(f.rows[0].values.sentStatus).toBe('');expect(await assignLead(f.lead.id,f.employee.id,undefined,true)).toMatchObject({assigned:false,reason:'Already sent'});
  const duplicate=await db.message.create({data:{idempotencyKey:'old-duplicate',leadId:f.lead.id,assignmentId:message.assignmentId,senderId:message.senderId,recipient:message.recipient,encryptedBody:message.encryptedBody}});
  await dispatchMessage(duplicate.id,f.whatsapp,f.source);expect(f.send).toHaveBeenCalledOnce();expect((await db.message.findUniqueOrThrow({where:{id:duplicate.id}})).status).toBe('CANCELLED');
 });
 it('submits only one of two competing queued messages for the same lead',async()=>{
  const f=await fixture();const message=await f.assign();const duplicate=await db.message.create({data:{idempotencyKey:'concurrent-duplicate',leadId:f.lead.id,assignmentId:message.assignmentId,senderId:message.senderId,recipient:message.recipient,encryptedBody:message.encryptedBody}});
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});f.send.mockImplementation(async()=>{await gate;return {id:'test-accepted-message',status:'SUBMITTED'};});
  const jobs=Promise.all([dispatchMessage(message.id,f.whatsapp,f.source),dispatchMessage(duplicate.id,f.whatsapp,f.source)]);
  try{await vi.waitFor(()=>expect(f.send).toHaveBeenCalledOnce());await vi.waitFor(async()=>expect(await db.message.count({where:{leadId:f.lead.id,status:'CANCELLED'}})).toBe(1));}
  finally{finish();await jobs;}
  expect(f.send).toHaveBeenCalledOnce();expect(await db.message.count({where:{leadId:f.lead.id,status:'SUBMITTED'}})).toBe(1);
 });
 it('preserves existing Sent and Shared To while saving feedback without fabricating a provider receipt',async()=>{
  const f=await fixture('Sent');const assignment=await db.assignment.create({data:{leadId:f.lead.id,employeeId:f.employee.id,isPrimary:true}});
  const lead=await db.lead.findUniqueOrThrow({where:{id:f.lead.id}});await saveFeedback(assignment.id,{status:'Interested',remarks:'Arrange a visit',version:lead.version});await writebackLead(lead.id,f.source);
  expect(f.source.write).toHaveBeenCalledWith(expect.anything(),f.lead.stableSourceId,null,{sentStatus:'Sent',sharedTo:'Original recipient',status:'Interested',feedback:'Arrange a visit'});expect(await db.message.count()).toBe(0);
 });
 it('holds a queued send if the current source cannot be verified',async()=>{
  const f=await fixture();const message=await f.assign();vi.mocked(f.source.read).mockRejectedValue(new AppError(502,'Google is unavailable'));
  await expect(dispatchMessage(message.id,f.whatsapp,f.source)).rejects.toThrow('Google is unavailable');expect(f.send).not.toHaveBeenCalled();expect(await db.message.findUniqueOrThrow({where:{id:message.id}})).toMatchObject({status:'QUEUED',attemptCount:0});
 });
});
