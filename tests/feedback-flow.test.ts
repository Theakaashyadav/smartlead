import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestModels } from './database-fixture';
import { db } from '@/lib/db';
import { AppError, hash, shortFeedbackToken, signedFeedbackToken } from '@/lib/security';
import { getFeedbackAccess } from '@/lib/engine';
import { DemoSheetsProvider } from '@/lib/google';
import { FEEDBACK_STATUSES } from '@/lib/feedback-statuses';
import { GET, POST } from '@/app/api/[...path]/route';

const deferred = vi.hoisted(()=>({callbacks:[] as (()=>Promise<void>)[]}));
vi.mock('next/server',async importOriginal=>({
  ...await importOriginal<typeof import('next/server')>(),
  after:vi.fn((callback:()=>Promise<void>)=>deferred.callbacks.push(callback)),
}));

async function fixture(token=shortFeedbackToken()){
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
  const employee=await db.employee.create({data:{organizationId:'legacy',name:'Recipient',phone:'+919876543210',projects:[]}});
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Enquiries',project:'Meadows',spreadsheetId:'feedback-demo',connectionType:'DEMO',columnMapping:{}}});
  const lead=await db.lead.create({data:{sheetId:sheet.id,stableSourceId:'customer',sourceRow:2,sourceFingerprint:'original',customerName:'Customer',mobile:'+919876543211',project:'Meadows'}});
  const assignment=await db.assignment.create({data:{leadId:lead.id,employeeId:employee.id}});
  const record=await db.feedbackToken.create({data:{assignmentId:assignment.id,tokenHash:hash(token),expiresAt:new Date(Date.now()+86400000)}});
  return {token,record,lead,assignment,sheet};
}
function request(token:string,method:'GET'|'POST'='GET',input?:unknown){
  const req=new Request(`http://localhost:3000/api/feedback/${token}`,{method,headers:{origin:'http://localhost:3000','content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
  return (method==='POST'?POST:GET)(req,{params:Promise.resolve({path:['feedback',token]})});
}
beforeEach(async()=>{
  vi.restoreAllMocks();deferred.callbacks.length=0;
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
});
afterAll(()=>db.$disconnect());

describe('short private feedback links',()=>{
  it('uses 22-character random tokens and enforces assignment revocation and expiry',async()=>{
    const f=await fixture();expect(f.token).toMatch(/^[\w-]{22}$/);
    expect((await getFeedbackAccess(f.token)).assignment.leadId).toBe(f.lead.id);
    await expect(getFeedbackAccess(shortFeedbackToken())).rejects.toMatchObject({status:410});
    await db.feedbackToken.update({where:{id:f.record.id},data:{expiresAt:new Date(0)}});
    await expect(getFeedbackAccess(f.token)).rejects.toMatchObject({status:410});
    await db.feedbackToken.update({where:{id:f.record.id},data:{expiresAt:new Date(Date.now()+86400000),revokedAt:new Date()}});
    await expect(getFeedbackAccess(f.token)).rejects.toMatchObject({status:410});
    await db.feedbackToken.update({where:{id:f.record.id},data:{revokedAt:null}});
    await db.assignment.update({where:{id:f.assignment.id},data:{active:false}});
    await expect(getFeedbackAccess(f.token)).rejects.toMatchObject({status:410});
  });
  it('keeps existing signed links working and exposes only the eight feedback choices',async()=>{
    const f=await fixture(signedFeedbackToken());
    await db.setting.create({data:{key:`statuses:${f.sheet.id}`,value:['New','Connected','An old custom status']}});
    const response=await request(f.token);expect(response.status).toBe(200);
    expect((await response.json()).data.statuses).toEqual(FEEDBACK_STATUSES);
    expect((await getFeedbackAccess(f.token)).assignmentId).toBe(f.assignment.id);
  });
});

describe('database-first feedback submission',()=>{
  it('commits feedback and its durable job before responding, then syncs after the response',async()=>{
    const f=await fixture();const write=vi.spyOn(DemoSheetsProvider.prototype,'write').mockResolvedValue(undefined);
    const response=await request(f.token,'POST',{status:'Followup (Hot Client)',remarks:'Call tomorrow afternoon.',version:0});
    expect(response.status).toBe(200);expect((await response.json()).data.lead).toMatchObject({version:1,writebackStatus:'PENDING'});
    expect(write).not.toHaveBeenCalled();expect(deferred.callbacks).toHaveLength(1);
    expect(await db.feedback.count({where:{leadId:f.lead.id}})).toBe(1);
    expect(await db.job.count({where:{entityId:f.lead.id,type:'WRITEBACK',status:'PENDING'}})).toBe(1);
    await deferred.callbacks[0]();
    expect(write).toHaveBeenCalledOnce();
    expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({writebackStatus:'SYNCED',lastFeedback:'Call tomorrow afternoon.'});
    expect(await db.job.count({where:{entityId:f.lead.id,status:'COMPLETED'}})).toBe(1);
  });
  it('preserves saved feedback and retries a failed sheet update without resubmitting',async()=>{
    const f=await fixture();vi.spyOn(DemoSheetsProvider.prototype,'write').mockRejectedValue(new AppError(503,'Sheet is temporarily offline'));
    expect((await request(f.token,'POST',{status:'Details Sent (Cold Client)',remarks:'Brochure sent on WhatsApp.',version:0})).status).toBe(200);
    await deferred.callbacks[0]();
    expect(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).toMatchObject({writebackStatus:'ERROR',status:'Details Sent (Cold Client)',lastFeedback:'Brochure sent on WhatsApp.'});
    expect(await db.job.findFirstOrThrow({where:{entityId:f.lead.id}})).toMatchObject({type:'WRITEBACK',status:'PENDING',attempts:1});
    expect(await db.feedback.count()).toBe(1);expect(await db.message.count()).toBe(0);
  });
  it('rejects old status choices and stale versions without adding feedback or jobs',async()=>{
    const f=await fixture();
    expect((await request(f.token,'POST',{status:'Connected',remarks:'Old client choice',version:0})).status).toBe(400);
    expect((await request(f.token,'POST',{status:'Interested',remarks:'Another user saved first',version:7})).status).toBe(409);
    expect(await db.feedback.count()).toBe(0);expect(await db.job.count()).toBe(0);expect(deferred.callbacks).toHaveLength(0);
  });
});
