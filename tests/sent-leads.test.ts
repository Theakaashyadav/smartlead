import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '@/lib/db';
import {assignLead,dispatchMessage,saveFeedback,synchronizeSheet,writebackLead} from '@/lib/engine';
import {AppError} from '@/lib/security';
import {clearTestModels} from './database-fixture';
import type {SheetProvider,SourceRow} from '@/lib/google';

beforeEach(async()=>{
 await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','Sender','Job','AuditLog','Setting']);
 await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Sent policy tests'},update:{}});
 await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(()=>db.$disconnect());
async function fixture(sentStatus=''){
 const sender=await db.sender.create({data:{organizationId:'legacy',name:'Test sender',provider:'DEMO',status:'CONNECTED'}});
 const employee=await db.employee.create({data:{organizationId:'legacy',name:'New recipient',phone:'+919800000001',projects:[]}});
 const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Source leads',project:'Project A',spreadsheetId:'sent-source-123456789012345',connectionType:'SIMPLE_APPS_SCRIPT',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{enabled:true,senderId:sender.id,template:'Lead',recipients:{create:{employeeId:employee.id,position:0}}}}}});
 const rows:SourceRow[]=[{stableId:'source-a',row:2,values:{customerName:'Customer A',mobile:'+919800000002',sentStatus,sharedTo:sentStatus?'Original recipient':''}},{stableId:'source-b',row:3,values:{customerName:'Customer B',mobile:'+919800000003',sentStatus:'',sharedTo:''}}];
 const source:SheetProvider={read:vi.fn(async()=>rows),write:vi.fn(async()=>{})};
 const send=vi.fn(async()=>({id:'test-accepted-message',status:'SUBMITTED' as const}));const whatsapp={sendMessage:send} as never;
 await synchronizeSheet(sheet.id,source);const lead=await db.lead.findUniqueOrThrow({where:{sheetId_stableSourceId:{sheetId:sheet.id,stableSourceId:'source-a'}}});
 const assign=async()=>{await assignLead(lead.id);return db.message.findFirstOrThrow({where:{leadId:lead.id},orderBy:{queuedAt:'asc'}});};
 return {sheet,employee,rows,source,send,whatsapp,lead,assign};
}
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
