import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '@/lib/db';
import {drainJobs,processJob,scheduleJobs} from '@/lib/engine';
import {simpleAction} from '@/lib/simple';
import {AppError} from '@/lib/security';
import {dispatchTestLeadFlow,type TestLeadFlow} from '@/lib/test-lead-flow';
import {UncertainDelivery,type WhatsAppProvider} from '@/lib/whatsapp';
import * as whatsapp from '@/lib/whatsapp';
import {clearTestModels} from './database-fixture';

beforeEach(async()=>{
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Test flow organisation'},update:{}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();});
afterAll(()=>db.$disconnect());

async function fixture(){
  const admin=await db.user.create({data:{organizationId:'legacy',name:'Test administrator',passwordHash:'unused',role:'SUPER_ADMIN'}});
  const sender=await db.sender.create({data:{organizationId:'legacy',name:'Linked WhatsApp',provider:'WEB',status:'CONNECTED'}});
  const input={requestId:crypto.randomUUID(),recipients:[{name:'Aman',phone:'+919876543211'}],executiveNotificationPhone:'+919876543217',notificationPhone:'+919876543218'};
  const send=vi.fn<WhatsAppProvider['sendMessage']>(async()=>({id:`test-${crypto.randomUUID()}`,status:'SUBMITTED'}));
  const provider={sendMessage:send} as unknown as WhatsAppProvider;
  const create=(data:unknown=input)=>simpleAction(['test-flow'],'POST',new Request('http://localhost/api/simple/test-flow',{method:'POST',body:JSON.stringify(data)}),admin) as Promise<TestLeadFlow>;
  const read=(id=input.requestId)=>simpleAction(['test-flow',id],'GET',new Request('http://localhost/api/simple/test-flow/'+id),admin) as Promise<TestLeadFlow>;
  return {admin,sender,input,send,provider,create,read};
}

describe('sheet-free test lead flow',()=>{
  it('queues once without a sheet and normalizes every number before saving',async()=>{
    const f=await fixture();
    const input={...f.input,recipients:[{name:' Aman ',phone:'98765 43211'}],executiveNotificationPhone:'9876543217',notificationPhone:'9876543218'};
    expect(await f.create(input)).toMatchObject({id:f.input.requestId,status:'QUEUED',recipients:[{name:'Aman',phone:'+919876543211',lead:{status:'WAITING'},executive:{status:'WAITING'},owner:{status:'WAITING'}}],executiveNotificationPhone:f.input.executiveNotificationPhone,notificationPhone:f.input.notificationPhone});
    await f.create(f.input);
    expect(await db.job.count({where:{type:'TEST_FLOW'}})).toBe(1);
    expect(await Promise.all([db.sheet.count(),db.lead.count(),db.message.count(),db.employee.count()])).toEqual([0,0,0,0]);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects changed destinations for an existing request and keeps its original run',async()=>{
    const f=await fixture();await f.create();
    await expect(f.create({...f.input,notificationPhone:'+919876543219'})).rejects.toMatchObject({status:409});
    expect(await f.read()).toMatchObject({notificationPhone:f.input.notificationPhone,status:'QUEUED'});
    expect(await db.job.count({where:{type:'TEST_FLOW'}})).toBe(1);
  });
  it('keeps status private to the organisation and administrator',async()=>{
    const f=await fixture();await f.create();
    const otherOrg=await db.organization.create({data:{name:'Other organisation'}});
    const other=await db.user.create({data:{organizationId:otherOrg.id,name:'Other owner',passwordHash:'unused',role:'SUPER_ADMIN'}});
    await expect(simpleAction(['test-flow',f.input.requestId],'GET',new Request('http://localhost'),other)).rejects.toMatchObject({status:404});
    await expect(simpleAction(['test-flow'],'POST',new Request('http://localhost',{method:'POST',body:JSON.stringify(f.input)}),{...f.admin,role:'EXECUTIVE'})).rejects.toMatchObject({status:403});
  });
  it('requires a connected account and a ready live worker',async()=>{
    const f=await fixture();
    await db.sender.update({where:{id:f.sender.id},data:{status:'DISCONNECTED'}});
    await expect(f.create()).rejects.toMatchObject({status:409});
    await db.sender.update({where:{id:f.sender.id},data:{status:'CONNECTED'}});
    vi.stubEnv('DEMO_MODE','false');
    await expect(f.create()).rejects.toMatchObject({code:'WHATSAPP_WORKER_OFFLINE'});
    await db.setting.create({data:{key:'simple:worker',value:{at:Date.now(),ready:false}}});
    await expect(f.create()).rejects.toMatchObject({code:'WHATSAPP_WORKER_OFFLINE'});
    await db.setting.update({where:{key:'simple:worker'},data:{value:{at:Date.now(),ready:true}}});
    expect(await f.create()).toMatchObject({status:'QUEUED'});
  });
  it('validates recipients and both notification numbers while allowing self-testing across roles',async()=>{
    const f=await fixture();
    for(const invalid of [
      {...f.input,recipients:[]},
      {...f.input,recipients:[...f.input.recipients,{name:'Duplicate',phone:'98765 43211'}]},
      {...f.input,executiveNotificationPhone:'bad'},
      {...f.input,notificationPhone:''},
      {...f.input,requestId:'invalid'},
      {...f.input,recipients:Array.from({length:11},(_,i)=>({name:`Person ${i}`,phone:`+9198765432${String(i).padStart(2,'0')}`}))},
    ])await expect(f.create(invalid)).rejects.toThrow();
    const phone=f.input.recipients[0].phone;
    expect(await f.create({...f.input,executiveNotificationPhone:phone,notificationPhone:phone})).toMatchObject({status:'QUEUED'});
  });
  it('sends one realistic sample and executive then owner notifications per recipient, with independent receipts',async()=>{
    const f=await fixture();f.input.recipients.push({name:'Akash',phone:'+919876543212'});await f.create();
    const beforeSend=vi.fn(async()=>{});
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider,beforeSend);
    const inputs=f.send.mock.calls.map(([input])=>input);
    expect(inputs.map(input=>input.to)).toEqual(['+919876543211','+919876543217','+919876543218','+919876543212','+919876543217','+919876543218']);
    expect(inputs[0].body).toContain('[TEST]');expect(inputs[0].body).toContain('SmartLead Test Lead');expect(inputs[0].body).toContain('0000000000');
    expect(inputs[0].body).not.toMatch(/https?:\/\//);expect(inputs[0].body).not.toContain('Submit Feedback');
    expect(inputs[1].body).toContain('New lead (SmartLead Test Lead) shared to (Aman).');expect(inputs[1].body).not.toContain('0000000000');
    expect(inputs[2].body).toContain('New lead (SmartLead Test Lead, 0000000000) shared to (Aman) and executive also updated.');
    expect(inputs[4].body).toContain('shared to (Akash)');
    expect(inputs.every(input=>input.body.startsWith('[TEST]'))).toBe(true);expect(beforeSend).toHaveBeenCalledTimes(6);
    const run=await f.read();expect(run.status).toBe('COMPLETED');
    for(const recipient of run.recipients){
      expect([recipient.lead.status,recipient.executive.status,recipient.owner.status]).toEqual(['SUBMITTED','SUBMITTED','SUBMITTED']);
      expect(new Set([recipient.lead.providerMessageId,recipient.executive.providerMessageId,recipient.owner.providerMessageId]).size).toBe(3);
    }
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);await f.create();expect(f.send).toHaveBeenCalledTimes(6);
    expect(await Promise.all([db.sheet.count(),db.lead.count(),db.message.count(),db.employee.count(),db.feedbackToken.count()])).toEqual([0,0,0,0,0]);
  });
  it('preserves group destinations for test leads and both notifications alongside contacts',async()=>{
    const f=await fixture();
    const group='120363123456789012@g.us',executiveGroup='919876543210-1234567890@g.us',ownerGroup='120363987654321098@g.us';
    const input={...f.input,recipients:[{name:'Sales team',phone:` ${group} `},...f.input.recipients],executiveNotificationPhone:executiveGroup,notificationPhone:ownerGroup};
    const queued=await f.create(input);
    expect(queued).toMatchObject({status:'QUEUED',recipients:[{name:'Sales team',phone:group},{name:'Aman',phone:'+919876543211'}],executiveNotificationPhone:executiveGroup,notificationPhone:ownerGroup});
    await f.create({...input,recipients:queued.recipients.map(({name,phone})=>({name,phone}))});
    expect(await db.job.count({where:{type:'TEST_FLOW'}})).toBe(1);
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);
    expect(f.send.mock.calls.map(([input])=>input.to)).toEqual([group,executiveGroup,ownerGroup,'+919876543211',executiveGroup,ownerGroup]);
    expect(f.send.mock.calls[1][0].body).toContain('shared to (Sales team).');
    expect(await f.read()).toMatchObject({status:'COMPLETED',executiveNotificationPhone:executiveGroup,notificationPhone:ownerGroup});
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);
    expect(f.send).toHaveBeenCalledTimes(6);
  });
  it('rejects malformed WhatsApp group identifiers and duplicate group recipients',async()=>{
    const f=await fixture();
    for(const destination of ['sales@g.us','120363123456789012@g.us.extra','120363123456789012@broadcast','120363123456789012@s.whatsapp.net','919876543210@g.us.extra','919876543210@broadcast','919876543210@s.whatsapp.net']){
      await expect(f.create({...f.input,recipients:[{name:'Sales team',phone:destination}]})).rejects.toThrow();
      await expect(f.create({...f.input,executiveNotificationPhone:destination})).rejects.toThrow();
      await expect(f.create({...f.input,notificationPhone:destination})).rejects.toThrow();
    }
    const group='120363123456789012@g.us';
    await expect(f.create({...f.input,recipients:[{name:'Sales team',phone:group},{name:'Duplicate group',phone:` ${group} `}]})).rejects.toMatchObject({status:400});
    expect(await db.job.count({where:{type:'TEST_FLOW'}})).toBe(0);
  });
  it.each(['lead','executive','owner'] as const)('stops on a confirmed %s rejection and never resends prior accepted stages',async stage=>{
    const f=await fixture();await f.create();
    const position=['lead','executive','owner'].indexOf(stage);
    for(let i=0;i<position;i++)f.send.mockResolvedValueOnce({id:`accepted-${i}`,status:'SUBMITTED'});
    f.send.mockRejectedValueOnce(new AppError(400,'Test number rejected'));
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);
    const run=await f.read();expect(run.status).toBe('FAILED');expect(run.recipients[0][stage].status).toBe('FAILED');expect(run.error).toContain('Test number rejected');
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);await f.create();
    expect(f.send).toHaveBeenCalledTimes(position+1);
    expect(Object.values(run.recipients[0]).filter(value=>typeof value==='object'&&value.status==='SUBMITTED')).toHaveLength(position);
  });
  it.each(['lead','executive','owner'] as const)('holds uncertain %s submissions and never sends subsequent confirmations',async stage=>{
    const f=await fixture();await f.create();const position=['lead','executive','owner'].indexOf(stage);
    for(let i=0;i<position;i++)f.send.mockResolvedValueOnce({id:`accepted-${i}`,status:'SUBMITTED'});
    f.send.mockRejectedValueOnce(new UncertainDelivery('Unknown test submission'));
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);
    expect(await f.read()).toMatchObject({status:'UNCERTAIN',recipients:[{[stage]:{status:'UNCERTAIN'}}]});
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);expect(f.send).toHaveBeenCalledTimes(position+1);
  });
  it('claims a queued run once when competing dispatchers arrive',async()=>{
    const f=await fixture();await f.create();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    f.send.mockImplementationOnce(async()=>{await gate;return {id:'lead-success',status:'SUBMITTED'};});
    const first=dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);
    try{await vi.waitFor(()=>expect(f.send).toHaveBeenCalledOnce());await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);expect(f.send).toHaveBeenCalledOnce();}
    finally{release();await first;}
    expect(f.send).toHaveBeenCalledTimes(3);expect((await f.read()).status).toBe('COMPLETED');
  });
  it('resumes only unsent stages after a confirmed pre-submission disconnection',async()=>{
    const f=await fixture();await f.create();
    f.send.mockResolvedValueOnce({id:'lead-accepted',status:'SUBMITTED'}).mockRejectedValueOnce(new AppError(409,'WhatsApp disconnected','DISCONNECTED'));
    await expect(dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider)).rejects.toMatchObject({code:'DISCONNECTED'});
    expect(await f.read()).toMatchObject({status:'QUEUED',recipients:[{lead:{status:'SUBMITTED'},executive:{status:'WAITING'},owner:{status:'WAITING'}}]});
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);
    expect(f.send.mock.calls.map(([input])=>input.to)).toEqual(['+919876543211','+919876543217','+919876543217','+919876543218']);
    expect((await f.read()).status).toBe('COMPLETED');
  });
  it('recovers a stopped worker without resending an interrupted executive notification',async()=>{
    const f=await fixture();await f.create();
    const key=`test-lead-flow:${f.admin.organizationId}:${f.input.requestId}`;
    const record=await db.setting.findUniqueOrThrow({where:{key}});
    const run=record.value as unknown as TestLeadFlow;
    const old=new Date(Date.now()-10*60000);
    run.status='RUNNING';run.updatedAt=old.toISOString();run.recipients[0].lead={status:'SUBMITTED',providerMessageId:'lead-accepted'};run.recipients[0].executive={status:'PROCESSING',lastAttemptAt:old.toISOString()};
    await db.setting.update({where:{key},data:{value:JSON.parse(JSON.stringify({...run,claimToken:'old-claim',claimedAt:old.toISOString()}))}});
    const job=await db.job.findFirstOrThrow({where:{type:'TEST_FLOW'}});
    await db.job.update({where:{id:job.id},data:{status:'PROCESSING',lockToken:'old-job',lockedAt:old}});
    vi.spyOn(whatsapp,'whatsappProvider').mockReturnValue(f.provider);
    await scheduleJobs(true);await processJob(job.id);
    expect(await f.read()).toMatchObject({status:'UNCERTAIN',recipients:[{lead:{status:'SUBMITTED'},executive:{status:'UNCERTAIN'},owner:{status:'WAITING'}}]});
    expect(f.send).not.toHaveBeenCalled();
    expect((await db.job.findUniqueOrThrow({where:{id:job.id}})).status).toBe('COMPLETED');
  });
  it('stops with a useful result if the linked sender was removed before sending',async()=>{
    const f=await fixture();await f.create();await db.sender.delete({where:{id:f.sender.id}});
    await dispatchTestLeadFlow(f.input.requestId,f.admin.organizationId,f.provider);
    const run=await f.read();expect(run.status).toBe('FAILED');expect(run.error).toContain('connection');expect(f.send).not.toHaveBeenCalled();
  });
  it('runs through the durable worker queue without any sheet jobs or real provider calls',async()=>{
    const f=await fixture();await f.create();vi.spyOn(whatsapp,'whatsappProvider').mockReturnValue(f.provider);
    expect(await drainJobs(1,0,f.admin.organizationId,()=>true,['TEST_FLOW'])).toBe(1);
    const job=await db.job.findFirstOrThrow({where:{type:'TEST_FLOW'}});expect(job.status).toBe('COMPLETED');
    await processJob(job.id);expect(f.send).toHaveBeenCalledTimes(3);expect((await f.read()).status).toBe('COMPLETED');
    expect(await db.job.count({where:{type:{in:['SYNC','ASSIGN','SEND','NOTIFY','WRITEBACK']}}})).toBe(0);
  });
});
