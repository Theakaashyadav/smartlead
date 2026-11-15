import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '@/lib/db';
import {assignLead,dispatchMessage,getFeedbackAccess,writebackLead} from '@/lib/engine';
import {simpleAction} from '@/lib/simple';
import {decrypt} from '@/lib/security';
import type {WhatsAppProvider} from '@/lib/whatsapp';
import {clearTestModels} from './database-fixture';

beforeEach(async()=>{
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Feedback link tests'},update:{}});
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(()=>db.$disconnect());

async function fixture(sendFeedbackLink?:boolean){
  const admin=await db.user.create({data:{organizationId:'legacy',name:'Administrator',passwordHash:'unused',role:'SUPER_ADMIN'}});
  const sender=await db.sender.create({data:{organizationId:'legacy',name:'Test sender',provider:'DEMO',status:'CONNECTED'}});
  const recipient=await db.employee.create({data:{organizationId:'legacy',name:'Recipient',phone:'+919876543211',projects:[]}});
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Lead sheet',project:'Project A',spreadsheetId:crypto.randomUUID(),connectionType:'SIMPLE_APPS_SCRIPT',sendFeedbackLink,columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{enabled:true,senderId:sender.id,template:'Lead',recipients:{create:{employeeId:recipient.id,position:0}}}}}});
  const lead=await db.lead.create({data:{sheetId:sheet.id,stableSourceId:'row-a',sourceRow:2,sourceFingerprint:'test',customerName:'Customer',mobile:'+919876543212',project:'Original project'}});
  const assign=async()=>{await assignLead(lead.id);return db.message.findFirstOrThrow({where:{leadId:lead.id},orderBy:{queuedAt:'desc'}});};
  const toggle=(value:unknown,user=admin)=>simpleAction(['sheets',sheet.id,'feedback-link'],'PUT',new Request('http://localhost',{method:'PUT',body:JSON.stringify({sendFeedbackLink:value})}),user);
  const send=vi.fn<WhatsAppProvider['sendMessage']>(async()=>({id:`test-${crypto.randomUUID()}`,status:'SUBMITTED'}));
  const provider={sendMessage:send} as unknown as WhatsAppProvider;
  return {admin,sheet,lead,recipient,assign,toggle,send,provider};
}

describe('per-sheet feedback link switch',()=>{
  it('keeps feedback links enabled by default',async()=>{
    const f=await fixture();expect(f.sheet.sendFeedbackLink).toBe(true);
    const queued=await f.assign();expect(decrypt(queued.encryptedBody)).toContain('*Submit Feedback*\nhttp://localhost:3000/f/');
    expect(await db.feedbackToken.count()).toBe(1);
  });
  it('sends full lead details without a feedback CTA, token, or public feedback dependency when off',async()=>{
    const f=await fixture(false);
    await db.setting.update({where:{key:'feedback:remoteRequired'},data:{value:true}});
    vi.stubEnv('PUBLIC_FEEDBACK_URL','');vi.stubEnv('APP_URL','http://localhost:3000');
    const queued=await f.assign();await dispatchMessage(queued.id,f.provider);
    expect(f.send).toHaveBeenCalledOnce();const body=f.send.mock.calls[0][0].body;
    expect(body).toContain('Name: *Customer*');expect(body).toContain('Phone: *+919876543212*');expect(body).toContain('Project');expect(body).toContain('Thank you!');
    expect(body).not.toContain('Submit Feedback');expect(body).not.toMatch(/https?:\/\/\S+\/(?:f|feedback)\//);
    expect(await db.feedbackToken.count()).toBe(0);
  });
  it('removes the link from queued messages immediately without reassigning or resending',async()=>{
    const f=await fixture();const queued=await f.assign();const jobs=await db.job.count();const assignment=queued.assignmentId;
    await f.toggle(false);
    const changed=await db.message.findUniqueOrThrow({where:{id:queued.id}});expect(decrypt(changed.encryptedBody)).not.toContain('Submit Feedback');expect(decrypt(changed.encryptedBody)).not.toContain('/f/');
    expect(changed.assignmentId).toBe(assignment);expect(changed.status).toBe('QUEUED');expect(await db.job.count()).toBe(jobs);expect(f.send).not.toHaveBeenCalled();
    await dispatchMessage(queued.id,f.provider);expect(f.send.mock.calls[0][0].body).not.toContain('/f/');
    expect(await simpleAction(['state'],'GET',new Request('http://localhost'),f.admin)).toMatchObject({sheets:[{sendFeedbackLink:false}]});
  });
  it('adds a valid link to an already queued message when turned on',async()=>{
    const f=await fixture(false);const queued=await f.assign();expect(await db.feedbackToken.count()).toBe(0);
    await f.toggle(true);
    const body=decrypt((await db.message.findUniqueOrThrow({where:{id:queued.id}})).encryptedBody);
    const token=body.match(/\/f\/([\w-]{22})/)![1];expect(body).toContain('*Submit Feedback*');expect((await getFeedbackAccess(token)).assignment.id).toBe(queued.assignmentId);
    await dispatchMessage(queued.id,f.provider);expect(f.send.mock.calls[0][0].body).toContain(token);expect(f.send).toHaveBeenCalledOnce();
  });
  it('preserves sent messages and existing feedback access when the switch changes',async()=>{
    const f=await fixture();const queued=await f.assign();const token=decrypt(queued.encryptedBody).match(/\/f\/([\w-]{22})/)![1];
    await dispatchMessage(queued.id,f.provider);const sent=await db.message.findUniqueOrThrow({where:{id:queued.id}});
    await f.toggle(false);await f.toggle(true);await dispatchMessage(queued.id,f.provider);
    expect(f.send).toHaveBeenCalledOnce();expect((await db.message.findUniqueOrThrow({where:{id:queued.id}})).encryptedBody).toBe(sent.encryptedBody);
    expect((await getFeedbackAccess(token)).assignment.id).toBe(queued.assignmentId);expect(await db.message.count()).toBe(1);
  });
  it('uses the latest sheet preference just before dispatch even when the queued body is older',async()=>{
    const f=await fixture();const queued=await f.assign();await db.sheet.update({where:{id:f.sheet.id},data:{sendFeedbackLink:false}});
    await db.setting.update({where:{key:'feedback:remoteRequired'},data:{value:true}});
    await dispatchMessage(queued.id,f.provider);expect(f.send).toHaveBeenCalledOnce();expect(f.send.mock.calls[0][0].body).not.toContain('Submit Feedback');
  });
  it('cleans up completed temporary leads without creating feedback references when links are off',async()=>{
    vi.stubEnv('LEAD_STORAGE_MODE','temporary');const f=await fixture(false);const queued=await f.assign();
    await dispatchMessage(queued.id,f.provider);await db.job.updateMany({where:{type:'SEND',entityId:queued.id},data:{status:'COMPLETED'}});
    await writebackLead(f.lead.id,{read:vi.fn(),write:vi.fn(async()=>{})});
    expect(await Promise.all([db.lead.count(),db.message.count(),db.assignment.count(),db.feedbackToken.count(),db.feedbackLink.count()])).toEqual([0,0,0,0,0]);
  });
  it('changes only the selected sheet and validates administrator scope and boolean values',async()=>{
    const f=await fixture();const other=await db.sheet.create({data:{organizationId:'legacy',name:'Other sheet',project:'Other',spreadsheetId:crypto.randomUUID(),connectionType:'SIMPLE_APPS_SCRIPT',columnMapping:{customerName:'Name',mobile:'Phone'}}});
    await expect(f.toggle(false,{...f.admin,organizationId:'different-organisation'})).rejects.toMatchObject({status:404});
    await expect(f.toggle(false,{...f.admin,role:'EXECUTIVE'})).rejects.toMatchObject({status:403});
    for(const invalid of ['false',null,1,undefined])await expect(f.toggle(invalid)).rejects.toThrow();
    await f.toggle(false);expect((await db.sheet.findUniqueOrThrow({where:{id:other.id}})).sendFeedbackLink).toBe(true);
  });
  it('saves the project and switch together, preserving the switch for older project-only updates',async()=>{
    const f=await fixture();const queued=await f.assign();
    const project=(value:unknown)=>simpleAction(['sheets',f.sheet.id,'project'],'PUT',new Request('http://localhost',{method:'PUT',body:JSON.stringify(value)}),f.admin);
    await project({project:'Updated project',sendFeedbackLink:false});
    expect(await db.sheet.findUniqueOrThrow({where:{id:f.sheet.id}})).toMatchObject({project:'Updated project',sendFeedbackLink:false});
    let body=decrypt((await db.message.findUniqueOrThrow({where:{id:queued.id}})).encryptedBody);expect(body).toContain('Updated project');expect(body).not.toContain('/f/');
    await project({project:'Another project'});expect((await db.sheet.findUniqueOrThrow({where:{id:f.sheet.id}})).sendFeedbackLink).toBe(false);
    await dispatchMessage(queued.id,f.provider);expect(f.send.mock.calls[0][0].body).toContain('Another project');expect(f.send.mock.calls[0][0].body).not.toContain('/f/');
  });
});
