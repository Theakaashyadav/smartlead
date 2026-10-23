import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { simpleAction } from '@/lib/simple';
import { registerOrganization } from '@/lib/organizations';
import { clearTestModels } from './database-fixture';

beforeEach(async()=>{
  vi.restoreAllMocks();
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.deleteMany({where:{id:{not:'legacy'}}});
});
afterAll(()=>db.$disconnect());

async function fixture(){
  const owner=await registerOrganization({name:'Owner',organizationName:'Agency',phone:'9876543210',pin:'4826'});
  const other=await registerOrganization({name:'Other Owner',organizationName:'Other Agency',phone:'9876543211',pin:'4826'});
  const sender=await db.sender.create({data:{organizationId:owner.organizationId,name:'WhatsApp',provider:'WEB'}});
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
  const message=await db.message.create({data:{leadId:lead.id,assignmentId:assignment.id,senderId:sender.id,idempotencyKey:'delete-message',recipient:employee.phone,encryptedBody:'unused'}});
  for(const [type,entityId]of [['SYNC',sheet.id],['ASSIGN',lead.id],['WRITEBACK',lead.id],['SEND',message.id],['SYNC',keep.id],['CONNECT',sender.id]]){
    await db.job.create({data:{organizationId:owner.organizationId,key:`${type}:${entityId}`,type,entityId}});
  }
  await db.sheetAccess.create({data:{sheetId:sheet.id,userId:owner.id}});
  await db.syncLog.create({data:{sheetId:sheet.id,operation:'IMPORT',status:'SUCCESS',details:'Imported'}});
  for(const key of [`statuses:${sheet.id}`,`demo-source:${sheet.id}`,'unrelated-setting'])await db.setting.create({data:{key,value:[]}});
  return {owner,other,sheet,keep,foreign,sender,employee,message};
}
const remove=(user:Awaited<ReturnType<typeof fixture>>['owner'],id:string)=>simpleAction(['sheets',id],'DELETE',new Request('http://localhost/api/simple/sheets/'+id,{method:'DELETE'}),user);

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
  it('rejects deletion while a job is running, then allows it when the job finishes',async()=>{
    const f=await fixture();
    await db.job.updateMany({where:{type:'SYNC',entityId:f.sheet.id},data:{status:'PROCESSING'}});
    await expect(remove(f.owner,f.sheet.id)).rejects.toMatchObject({status:409});
    expect(await db.lead.count()).toBe(1);expect(await db.feedbackToken.count()).toBe(1);expect(await db.sheet.count()).toBe(3);
    await db.job.updateMany({where:{type:'SYNC',entityId:f.sheet.id},data:{status:'COMPLETED'}});
    expect(await remove(f.owner,f.sheet.id)).toEqual({deleted:true});
  });
  it('keeps the whole sheet when WhatsApp may be submitting a message',async()=>{
    const f=await fixture();await db.message.update({where:{id:f.message.id},data:{status:'PROCESSING'}});
    await expect(remove(f.owner,f.sheet.id)).rejects.toMatchObject({status:409});
    expect(await db.sheet.count()).toBe(3);expect(await db.job.count()).toBe(6);expect(await db.assignment.count()).toBe(1);
  });
  it('deletes an empty connection and returns not found for a repeat or unknown ID',async()=>{
    const f=await fixture();expect(await remove(f.owner,f.keep.id)).toEqual({deleted:true});
    await expect(remove(f.owner,f.keep.id)).rejects.toMatchObject({status:404});
    await expect(remove(f.owner,'unknown')).rejects.toMatchObject({status:404});
    expect(await db.sheet.count()).toBe(2);
  });
});
