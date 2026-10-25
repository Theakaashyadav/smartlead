import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { clearTestModels } from './database-fixture';
import { AppError, decrypt, hash, signedFeedbackToken } from '@/lib/security';
import { getFeedbackAccess, processJob, synchronizeSheet, updateLeadSheetNow, writebackLead } from '@/lib/engine';
import * as google from '@/lib/google';
import type { SheetProvider, SourceRow } from '@/lib/google';
import { DEFAULT_TEMPLATE } from '@/lib/validation';
import { invalidateTemporarySource, maintainTemporaryStorage, purgeCompletedLead, saveTemporaryFeedback, temporaryLeadStorage } from '@/lib/temporary-leads';
import { simpleAction } from '@/lib/simple';
import { GET, POST } from '@/app/api/[...path]/route';

const deferred=vi.hoisted(()=>({callbacks:[] as (()=>Promise<void>)[]}));
vi.mock('next/server',async importOriginal=>({...await importOriginal<typeof import('next/server')>(),after:vi.fn((callback:()=>Promise<void>)=>deferred.callbacks.push(callback))}));

beforeEach(async()=>{
  vi.restoreAllMocks();vi.unstubAllEnvs();vi.stubEnv('LEAD_STORAGE_MODE','temporary');deferred.callbacks=[];
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
});
afterAll(()=>db.$disconnect());

async function fixture(options:{sent?:boolean;notification?:boolean}={}){
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
  const employee=await db.employee.create({data:{organizationId:'legacy',name:'Aman',phone:'+919876543210',projects:[]}});
  const sender=await db.sender.create({data:{organizationId:'legacy',name:'WhatsApp',provider:'DEMO',status:'CONNECTED'}});
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Enquiries',project:'Meadows',spreadsheetId:'temporary-test',connectionType:'SIMPLE_APPS_SCRIPT',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{mode:'SINGLE',senderId:sender.id,template:DEFAULT_TEMPLATE,enabled:true,notificationPhone:options.notification?'+919876543212':null,recipients:{create:{employeeId:employee.id,position:0}}}}}});
  const rows:SourceRow[]=[{stableId:'source-1',row:2,values:{customerName:'Private Customer',mobile:'+919876543211',project:'Meadows',sentStatus:options.sent?'Sent':'',sharedTo:options.sent?'Aman':'',status:'',feedback:''},questions:[{question:'What is your purpose?',answer:'self-use'}]}];
  const controls={fail:false};
  const provider:SheetProvider={read:vi.fn(async()=>structuredClone(rows)),write:vi.fn(async(_sheet,id,_metadata,values)=>{
    if(controls.fail)throw new AppError(502,'Sheet is temporarily unavailable');
    const row=rows.find(row=>row.stableId===id);if(!row)throw new AppError(409,'Source row was deleted','SYNC_CONFLICT');
    Object.assign(row.values,values);return {...values};
  })};
  vi.spyOn(google,'sheetProvider').mockReturnValue(provider);
  return {sheet,employee,sender,rows,provider,controls};
}
async function sentFixture(options:{notification?:boolean}={}){
  const f=await fixture(options);await synchronizeSheet(f.sheet.id,f.provider);
  const lead=await db.lead.findFirstOrThrow({where:{sheetId:f.sheet.id}});
  await processJob((await db.job.findFirstOrThrow({where:{type:'ASSIGN',entityId:lead.id}})).id);
  const message=await db.message.findFirstOrThrow({where:{leadId:lead.id}});
  const token=decrypt(message.encryptedBody).match(/\/f\/([\w-]+)/)![1];
  await processJob((await db.job.findFirstOrThrow({where:{type:'SEND',entityId:message.id}})).id);
  return {...f,lead,message,token};
}
async function purgedFixture(){const f=await sentFixture();await updateLeadSheetNow(f.lead.id);return {...f,link:await db.feedbackLink.findUniqueOrThrow({where:{tokenHash:hash(f.token)}})};}
function request(token:string,method:'GET'|'POST'='GET',input?:unknown){
  const request=new Request(`http://localhost:3000/api/feedback/${token}`,{method,headers:{origin:'http://localhost:3000','content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
  return (method==='POST'?POST:GET)(request,{params:Promise.resolve({path:['feedback',token]})});
}

describe('temporary lead processing',()=>{
  it('uses temporary storage by default for live sheets and preserves isolated demo fixtures',()=>{
    vi.stubEnv('LEAD_STORAGE_MODE','');expect(temporaryLeadStorage({connectionType:'SIMPLE_APPS_SCRIPT'})).toBe(true);
    expect(temporaryLeadStorage({connectionType:'DEMO'})).toBe(false);
  });
  it('does not copy already-sent sheet rows into the database or create send jobs',async()=>{
    const f=await fixture({sent:true});await synchronizeSheet(f.sheet.id,f.provider);
    expect(await db.lead.count()).toBe(0);expect(await db.job.count()).toBe(0);
    expect(await db.sheet.findUniqueOrThrow({where:{id:f.sheet.id}})).toMatchObject({sourceSummary:{total:1,sent:1}});
  });
  it('keeps pending lead data until send and sheet confirmation, then removes the entire processing graph',async()=>{
    const f=await sentFixture();expect(await db.lead.count()).toBe(1);expect(await db.message.count()).toBe(1);
    expect(await purgeCompletedLead(f.lead.id)).toBe(false);
    expect(await updateLeadSheetNow(f.lead.id)).toEqual({status:'SYNCED',error:null});
    expect(f.rows[0].values).toMatchObject({sentStatus:'Sent',sharedTo:'Aman'});
    expect(await Promise.all([db.lead.count(),db.message.count(),db.assignment.count(),db.feedbackToken.count(),db.feedback.count(),db.followup.count(),db.job.count(),db.auditLog.count({where:{entityType:'lead'}})])).toEqual(Array(8).fill(0));
    const lookup=await db.feedbackLink.findUniqueOrThrow({where:{tokenHash:hash(f.token)}});
    expect(decrypt(lookup.encryptedSourceId)).toBe('source-1');expect(JSON.stringify(lookup)).not.toContain('Private Customer');expect(JSON.stringify(lookup)).not.toContain('+919876543211');
    expect(await db.sender.count()).toBe(1);expect(await db.employee.count()).toBe(1);expect(await db.sheet.count()).toBe(1);expect(await db.ruleRecipient.count()).toBe(1);
  });
  it('never removes data after a failed or unconfirmed sheet write',async()=>{
    const f=await sentFixture();f.controls.fail=true;await updateLeadSheetNow(f.lead.id);
    expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({writebackStatus:'ERROR'});
    expect(await db.message.count()).toBe(1);expect(await db.feedbackLink.count()).toBe(0);expect(await purgeCompletedLead(f.lead.id)).toBe(false);
    f.controls.fail=false;await updateLeadSheetNow(f.lead.id);expect(await db.lead.count()).toBe(0);expect(await db.feedbackLink.count()).toBe(1);
  });
  it('waits for sent notifications before removing their temporary message records',async()=>{
    const f=await sentFixture({notification:true});await updateLeadSheetNow(f.lead.id);
    expect(await db.lead.count()).toBe(1);const job=await db.job.findFirstOrThrow({where:{type:'NOTIFY',status:'PENDING'}});
    await processJob(job.id);expect(await db.lead.count()).toBe(0);expect(await db.message.count()).toBe(0);expect(await db.feedbackLink.count()).toBe(1);
  });
  it('keeps uncertain deliveries for reconciliation',async()=>{
    const f=await sentFixture();await db.message.update({where:{id:f.message.id},data:{uncertain:true,status:'FAILED'}});
    await writebackLead(f.lead.id,f.provider);expect(await db.lead.count()).toBe(1);expect(await db.message.count()).toBe(1);
  });
  it('does not reimport completed leads or blindly resend when a Sent marker is cleared',async()=>{
    const f=await purgedFixture();await synchronizeSheet(f.sheet.id,f.provider);
    expect(await db.lead.count()).toBe(0);expect(await db.message.count()).toBe(0);
    f.rows[0].values.sentStatus='';await synchronizeSheet(f.sheet.id,f.provider);
    expect(await db.lead.count()).toBe(0);expect(await db.job.count()).toBe(0);
  });
  it('migrates confirmed existing records while preserving short and signed links and their original expiry',async()=>{
    vi.stubEnv('LEAD_STORAGE_MODE','permanent');const f=await sentFixture();await updateLeadSheetNow(f.lead.id);
    const assignment=await db.assignment.findFirstOrThrow({where:{leadId:f.lead.id,isPrimary:true}});const oldToken=signedFeedbackToken();const expiresAt=new Date(Date.now()+3600000);
    await db.feedbackToken.create({data:{assignmentId:assignment.id,tokenHash:hash(oldToken),expiresAt}});
    vi.stubEnv('LEAD_STORAGE_MODE','temporary');expect(await purgeCompletedLead(f.lead.id,f.rows[0])).toBe(true);
    expect(await db.lead.count()).toBe(0);expect((await getFeedbackAccess(oldToken)).expiresAt).toEqual(expiresAt);
    expect((await getFeedbackAccess(f.token)).assignment.employeeId).toBe(f.employee.id);expect(await db.feedbackLink.count()).toBe(2);
  });
  it('reports sheet-level totals after lead and message records have been removed',async()=>{
    const f=await purgedFixture();await synchronizeSheet(f.sheet.id,f.provider);
    const owner=await db.user.create({data:{organizationId:'legacy',name:'Owner',email:'owner@test.invalid',passwordHash:'fixture',role:'SUPER_ADMIN'}});
    const state=await simpleAction(['state'],'GET',new Request('http://localhost'),owner) as {sheets:Array<{leadCount:number;delivery:{submitted:number}}>};
    expect(state.sheets[0]).toMatchObject({leadCount:1,delivery:{submitted:1}});expect(await db.lead.count()).toBe(0);expect(await db.message.count()).toBe(0);
  });
  it('revokes the old expiring lookup when recipients explicitly reopen an unsent sheet row',async()=>{
    const f=await purgedFixture();f.rows[0].values.sentStatus='';
    await db.sender.update({where:{id:f.sender.id},data:{provider:'WEB'}});
    const owner=await db.user.create({data:{organizationId:'legacy',name:'Owner',email:'owner@test.invalid',passwordHash:'fixture',role:'SUPER_ADMIN'}});
    await simpleAction(['sheets',f.sheet.id,'recipients'],'PUT',new Request('http://localhost',{method:'PUT',body:JSON.stringify({recipients:[{name:'Aman',phone:f.employee.phone}]})}),owner,f.provider);
    await expect(getFeedbackAccess(f.token)).rejects.toMatchObject({status:410});expect(await db.job.count({where:{type:'ASSIGN',status:'PENDING'}})).toBe(1);
  });
  it('removes expired lookups and old completed housekeeping records without touching connections',async()=>{
    const f=await purgedFixture();await db.feedbackLink.update({where:{id:f.link.id},data:{expiresAt:new Date(0)}});
    await db.syncLog.create({data:{sheetId:f.sheet.id,operation:'IMPORT',status:'SUCCESS',details:'Old import',createdAt:new Date(0)}});
    await db.job.create({data:{organizationId:'legacy',key:'old-housekeeping',type:'SYNC',entityId:f.sheet.id,status:'COMPLETED',createdAt:new Date(0)}});
    await db.job.create({data:{organizationId:'legacy',key:'recent-completed',type:'WRITEBACK',entityId:'already-finished',status:'COMPLETED'}});
    await db.syncLog.create({data:{sheetId:f.sheet.id,operation:'WRITEBACK',status:'SUCCESS',details:'Confirmed'}});
    await maintainTemporaryStorage();expect(await db.feedbackLink.count()).toBe(0);expect(await db.syncLog.count()).toBe(0);expect(await db.job.count()).toBe(0);
    expect(await db.sheet.count()).toBe(1);expect(await db.sender.count()).toBe(1);expect(await db.employee.count()).toBe(1);
  });
  it('removes a deleted sheet’s expiring references without changing its source',async()=>{
    const f=await purgedFixture();const original=structuredClone(f.rows);
    const owner=await db.user.create({data:{organizationId:'legacy',name:'Owner',email:'owner@test.invalid',passwordHash:'fixture',role:'SUPER_ADMIN'}});
    await simpleAction(['sheets',f.sheet.id],'DELETE',new Request('http://localhost',{method:'DELETE'}),owner);
    expect(await db.feedbackLink.count()).toBe(0);expect(f.rows).toEqual(original);expect(await db.sender.count()).toBe(1);expect(await db.user.count()).toBe(1);
  });
});

describe('reusable sheet-backed feedback links',()=>{
  it('reads current questions and lead details from Sheets without saving another database copy',async()=>{
    const f=await purgedFixture();const response=await request(f.token);
    expect(response.status).toBe(200);expect((await response.json()).data.lead).toMatchObject({customerName:'Private Customer',questions:[{question:'What is your purpose?',answer:'self-use'}],writebackStatus:'SYNCED',version:f.link.version});
    expect(await db.lead.count()).toBe(0);expect(await db.assignment.count()).toBe(0);expect(await db.feedback.count()).toBe(0);
  });
  it('commits a feedback submission and durable job with zero Google calls before returning',async()=>{
    const f=await purgedFixture();vi.mocked(f.provider.read).mockClear();vi.mocked(f.provider.write).mockClear();
    const response=await request(f.token,'POST',{status:'Interested',remarks:'Arrange a visit tomorrow.',version:f.link.version});
    expect(response.status).toBe(200);expect((await response.json()).data.lead).toMatchObject({version:f.link.version+1,writebackStatus:'PENDING'});
    expect(f.provider.read).not.toHaveBeenCalled();expect(f.provider.write).not.toHaveBeenCalled();
    expect(await db.feedback.count()).toBe(1);expect(await db.job.count({where:{type:'WRITEBACK',status:'PENDING'}})).toBe(1);
    expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({customerName:'[Queued feedback]',mobile:'',lastFeedback:'Arrange a visit tomorrow.'});
    await deferred.callbacks[0]();
    expect(f.rows[0].values).toMatchObject({status:'Interested',feedback:'Arrange a visit tomorrow.',sentStatus:'Sent',sharedTo:'Aman'});
    expect(await db.lead.count()).toBe(0);expect(await db.feedback.count()).toBe(0);expect(await db.job.count()).toBe(0);
  });
  it('keeps the same link reusable across several complete save/sync/remove cycles',async()=>{
    const f=await purgedFixture();
    for(const remarks of ['First conversation','Second conversation']){
      const access=await getFeedbackAccess(f.token);const version=access.assignment.lead.version;
      expect((await request(f.token,'POST',{status:'Followup (Hot Client)',remarks,version})).status).toBe(200);
      await deferred.callbacks.shift()!();
      expect(await db.lead.count()).toBe(0);expect(await db.feedback.count()).toBe(0);expect(f.rows[0].values.feedback).toBe(remarks);
    }
    expect(await db.feedbackLink.count()).toBe(1);
  });
  it('preserves queued feedback during an outage, then deletes it only after a confirmed retry',async()=>{
    const f=await purgedFixture();f.controls.fail=true;
    await request(f.token,'POST',{status:'No Answer',remarks:'Call back next week',version:f.link.version});await deferred.callbacks[0]();
    expect(await db.feedback.count()).toBe(1);expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({writebackStatus:'ERROR',lastFeedback:'Call back next week'});
    f.controls.fail=false;await updateLeadSheetNow(f.lead.id);
    expect(f.rows[0].values.feedback).toBe('Call back next week');expect(await db.feedback.count()).toBe(0);expect(await db.lead.count()).toBe(0);
  });
  it('keeps deleted or externally edited rows from being silently overwritten',async()=>{
    const f=await purgedFixture();f.rows[0].values.feedback='Manual sheet edit';
    await request(f.token,'POST',{status:'Interested',remarks:'Submitted from an old tab',version:f.link.version});await deferred.callbacks[0]();
    expect(f.rows[0].values.feedback).toBe('Manual sheet edit');expect(await db.feedback.count()).toBe(1);
    expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({writebackStatus:'ERROR'});
  });
  it('locates a moved row using its source identity',async()=>{
    const f=await purgedFixture();f.rows[0].row=19;invalidateTemporarySource(f.sheet.id);
    await request(f.token,'POST',{status:'Site Visit Scheduled',remarks:'Confirmed for Sunday',version:f.link.version});await deferred.callbacks[0]();
    expect(f.rows[0].values.feedback).toBe('Confirmed for Sunday');expect(await db.lead.count()).toBe(0);
  });
  it('rejects stale concurrent updates atomically',async()=>{
    const f=await purgedFixture();const input={status:'Interested',remarks:'First writer wins',version:f.link.version};
    await saveTemporaryFeedback(f.link,input);
    await expect(saveTemporaryFeedback(f.link,{...input,remarks:'Stale writer'})).rejects.toMatchObject({status:409});
    expect(await db.feedback.count()).toBe(1);expect(await db.job.count({where:{type:'WRITEBACK'}})).toBe(1);
  });
  it('rejects expired links and inactive recipients without reading Google Sheets',async()=>{
    const f=await purgedFixture();vi.mocked(f.provider.read).mockClear();
    await db.feedbackLink.update({where:{id:f.link.id},data:{expiresAt:new Date(0)}});
    expect((await request(f.token,'POST',{status:'Interested',remarks:'Do not save',version:f.link.version})).status).toBe(410);
    await db.feedbackLink.update({where:{id:f.link.id},data:{expiresAt:new Date(Date.now()+60000)}});await db.employee.update({where:{id:f.employee.id},data:{active:false}});
    expect((await request(f.token,'POST',{status:'Interested',remarks:'Do not save',version:f.link.version})).status).toBe(410);
    expect(f.provider.read).not.toHaveBeenCalled();expect(await db.feedback.count()).toBe(0);
  });
  it('advances the link version after an external sheet edit and preserves raw answers',async()=>{
    const f=await purgedFixture();f.rows[0].values.feedback='Latest sheet note';invalidateTemporarySource(f.sheet.id);
    const access=await getFeedbackAccess(f.token);expect(access.assignment.lead.version).toBe(f.link.version+1);expect(access.assignment.lead.lastFeedback).toBe('Latest sheet note');
    expect(await db.lead.count()).toBe(0);
  });
  it('shows the real customer and the queued feedback while the background save is pending',async()=>{
    const f=await purgedFixture();await request(f.token,'POST',{status:'Interested',remarks:'Queued customer update',version:f.link.version});
    const response=await request(f.token);expect((await response.json()).data.lead).toMatchObject({customerName:'Private Customer',lastFeedback:'Queued customer update',writebackStatus:'PENDING',version:f.link.version+1});
  });
  it('retains the submission if its source row is deleted before background processing',async()=>{
    const f=await purgedFixture();f.rows.length=0;
    expect((await request(f.token,'POST',{status:'Interested',remarks:'Keep this feedback safe',version:f.link.version})).status).toBe(200);await deferred.callbacks[0]();
    expect(await db.feedback.count()).toBe(1);expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({writebackStatus:'ERROR'});expect(f.provider.write).toHaveBeenCalledTimes(1);
  });
  it('accepts only one simultaneous submission with the same version',async()=>{
    const f=await purgedFixture();const input={status:'Interested',remarks:'A concurrent update',version:f.link.version};
    const results=await Promise.allSettled([saveTemporaryFeedback(f.link,input),saveTemporaryFeedback(f.link,input)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);expect(await db.feedback.count()).toBe(1);
  });
  it('does not delete a newer feedback update that arrives during a sheet write',async()=>{
    const f=await purgedFixture();await request(f.token,'POST',{status:'Interested',remarks:'First update',version:f.link.version});
    vi.mocked(f.provider.write).mockImplementationOnce(async(_sheet,_stableId,_metadata,values)=>{
      const current=await db.feedbackLink.findUniqueOrThrow({where:{id:f.link.id}});
      await saveTemporaryFeedback(current,{status:'Site Visit Scheduled',remarks:'Newer update during write',version:current.version});
      Object.assign(f.rows[0].values,values);return {...values};
    });
    await deferred.callbacks[0]();expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({lastFeedback:'Newer update during write',writebackStatus:'PENDING'});
    await updateLeadSheetNow(f.lead.id);expect(f.rows[0].values.feedback).toBe('Newer update during write');expect(await db.lead.count()).toBe(0);expect(await db.feedback.count()).toBe(0);
  });
});
