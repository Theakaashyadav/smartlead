import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { clearTestModels } from './database-fixture';
import { drainJobs, processJob, scheduleJobs, synchronizeSheet } from '@/lib/engine';
import { sheetPollSeconds } from '@/lib/automation-policy';
import { DemoWhatsAppProvider } from '@/lib/whatsapp';
import { DemoSheetsProvider, type SheetProvider, type SourceRow } from '@/lib/google';
import { SIMPLE_TEMPLATE } from '@/lib/simple-shared';

beforeEach(async()=>{
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','Sender','Job','Setting']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Speed test'},update:{}});
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
afterAll(()=>db.$disconnect());

async function fixture(){
  const sender=await db.sender.create({data:{organizationId:'legacy',name:'Test sender',provider:'DEMO',status:'CONNECTED'}});
  const employee=await db.employee.create({data:{organizationId:'legacy',name:'Selected recipient',phone:'+919876543211',projects:[]}});
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Meta leads',project:'Sales',spreadsheetId:'public-speed-test-spreadsheet',connectionType:'SIMPLE_PUBLIC',syncInterval:60,columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{enabled:true,senderId:sender.id,mode:'ROUND_ROBIN',template:SIMPLE_TEMPLATE,recipients:{create:{employeeId:employee.id,position:0}}}}}});
  const rows:SourceRow[]=Array.from({length:5},(_,i)=>({stableId:`source-${i}`,row:i+2,values:{customerName:`Lead ${i}`,mobile:`+91980000${String(i).padStart(4,'0')}`}}));
  const provider:SheetProvider={read:vi.fn(async()=>rows),write:vi.fn()};
  return {sheet,rows,provider};
}

describe('fast public-sheet lead delivery',()=>{
  it('starts a new delivery write ahead of a backlog of failing sheet retries',async()=>{
    const f=await fixture();await synchronizeSheet(f.sheet.id,f.provider,{refreshQueued:false});await db.sheet.update({where:{id:f.sheet.id},data:{connectionType:'DEMO'}});
    const leads=await db.lead.findMany({where:{sheetId:f.sheet.id},orderBy:{sourceRow:'asc'}});
    await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:leads[0].id,key:'retry-backlog',runAt:new Date(0),error:'Old script failure'}});
    const fresh=await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:leads[1].id,key:'new-delivery',runAt:new Date(Date.now()-1000)}});
    const write=vi.spyOn(DemoSheetsProvider.prototype,'write').mockResolvedValue(undefined);
    await drainJobs(1,0,undefined,()=>true,['WRITEBACK']);expect(write.mock.calls[0][1]).toBe(leads[1].stableSourceId);expect((await db.job.findUniqueOrThrow({where:{id:fresh.id}})).status).toBe('COMPLETED');
  });
  it('runs waiting output work ahead of an older failed job whose retry became due later',async()=>{
    const f=await fixture();await synchronizeSheet(f.sheet.id,f.provider,{refreshQueued:false});
    const leads=await db.lead.findMany({where:{sheetId:f.sheet.id},orderBy:{sourceRow:'asc'}});
    const old=await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:leads[0].id,key:'old-failing-sheet',createdAt:new Date(0),runAt:new Date(Date.now()-1000)}});
    const waiting=await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:leads[1].id,key:'waiting-sheet',runAt:new Date(Date.now()-5000)}});
    await db.sheet.update({where:{id:f.sheet.id},data:{connectionType:'DEMO'}});
    const write=vi.spyOn(DemoSheetsProvider.prototype,'write').mockResolvedValue(undefined);
    await drainJobs(1,0,undefined,()=>true,['WRITEBACK']);
    expect(write).toHaveBeenCalledOnce();expect(write.mock.calls[0][1]).toBe(leads[1].stableSourceId);
    expect((await db.job.findUniqueOrThrow({where:{id:waiting.id}})).status).toBe('COMPLETED');
    expect((await db.job.findUniqueOrThrow({where:{id:old.id}})).status).toBe('PENDING');
  });
  it('coalesces competing output jobs and retains full feedback when a delivery job owns the claim',async()=>{
    const f=await fixture();await synchronizeSheet(f.sheet.id,f.provider,{refreshQueued:false});await db.sheet.update({where:{id:f.sheet.id},data:{connectionType:'DEMO'}});
    const lead=await db.lead.findFirstOrThrow({where:{sheetId:f.sheet.id}});
    await db.lead.update({where:{id:lead.id},data:{status:'Interested',lastFeedback:'Save this feedback',writebackStatus:'PENDING'}});
    const first=await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:lead.id,key:'writeback:delivery:coalesce',runAt:new Date(0)}});
    const second=await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:lead.id,key:'writeback:feedback:coalesce',runAt:new Date(0)}});
    let finish!:()=>void;const waiting=new Promise<void>(resolve=>{finish=resolve;});
    const write=vi.spyOn(DemoSheetsProvider.prototype,'write').mockImplementation(async()=>{await waiting;});
    const run=processJob(first.id);
    try{await vi.waitFor(()=>expect(write).toHaveBeenCalledOnce());expect(await processJob(second.id)).toBe(false);}
    finally{finish();await run;}
    expect(write.mock.calls[0][3]).toMatchObject({status:'Interested',feedback:'Save this feedback'});
    expect(await db.job.count({where:{id:{in:[first.id,second.id]},status:'COMPLETED'}})).toBe(2);
  });
  it('queues a partially filled Meta row once its phone is available',async()=>{
    const f=await fixture();f.rows.splice(0,f.rows.length,{stableId:'meta-lead-id',row:2,values:{customerName:'Pending Meta lead',mobile:''}});
    await synchronizeSheet(f.sheet.id,f.provider,{skipUnchanged:true,refreshQueued:false});
    expect(await db.job.count({where:{type:'ASSIGN'}})).toBe(0);
    f.rows[0].values.mobile='+919800001111';
    await synchronizeSheet(f.sheet.id,f.provider,{skipUnchanged:true,refreshQueued:false});
    await synchronizeSheet(f.sheet.id,f.provider,{skipUnchanged:true,refreshQueued:false});
    expect(await db.lead.count()).toBe(1);expect(await db.job.count({where:{type:'ASSIGN'}})).toBe(1);
  });
  it('polls existing minute-based public connections after five seconds and coalesces in-flight polls',async()=>{
    const f=await fixture();
    await db.sheet.update({where:{id:f.sheet.id},data:{lastSyncAt:new Date(Date.now()-6000)}});
    expect(sheetPollSeconds(f.sheet)).toBe(5);
    expect(sheetPollSeconds({connectionType:'SERVICE_ACCOUNT',syncInterval:180})).toBe(180);
    await scheduleJobs(false,false);await scheduleJobs(false,false);
    const jobs=await db.job.findMany({where:{type:'SYNC',entityId:f.sheet.id}});
    expect(jobs).toHaveLength(1);
    await db.job.update({where:{id:jobs[0].id},data:{status:'PROCESSING'}});
    await scheduleJobs(false,false);
    expect(await db.job.count({where:{type:'SYNC',entityId:f.sheet.id}})).toBe(1);
    expect((await db.sheet.findUniqueOrThrow({where:{id:f.sheet.id}})).syncInterval).toBe(60);
  });
  it('skips unchanged rows and bulk-loads identities when a new Meta lead arrives',async()=>{
    const f=await fixture();
    await synchronizeSheet(f.sheet.id,f.provider,{skipUnchanged:true,refreshQueued:false});
    const reads=vi.spyOn(db.lead,'findMany');const updates=vi.spyOn(db.lead,'update');
    const logs=vi.spyOn(db.syncLog,'create');
    expect(await synchronizeSheet(f.sheet.id,f.provider,{skipUnchanged:true,refreshQueued:false})).toEqual({imported:0,checked:5});
    expect(reads).not.toHaveBeenCalled();expect(updates).not.toHaveBeenCalled();expect(logs).not.toHaveBeenCalled();
    f.rows.push({stableId:'new-meta-lead',row:7,values:{customerName:'New Meta lead',mobile:'+919800001111'}});
    expect(await synchronizeSheet(f.sheet.id,f.provider,{skipUnchanged:true,refreshQueued:false})).toEqual({imported:1,checked:6});
    expect(reads).toHaveBeenCalledOnce();expect(updates).not.toHaveBeenCalled();
    expect(await db.lead.count({where:{sheetId:f.sheet.id}})).toBe(6);
    expect(await db.job.count({where:{type:'ASSIGN'}})).toBe(6);
  });
  it('sends the first assigned lead before assigning the remaining batch',async()=>{
    const f=await fixture();await synchronizeSheet(f.sheet.id,f.provider,{refreshQueued:false});
    const assignedAtSend:number[]=[];const send=DemoWhatsAppProvider.prototype.sendMessage;
    vi.spyOn(DemoWhatsAppProvider.prototype,'sendMessage').mockImplementation(async function(this:DemoWhatsAppProvider,input){
      assignedAtSend.push(await db.assignment.count());return send.call(this,input);
    });
    await drainJobs(100,0,undefined,()=>true,['ASSIGN','SEND']);
    expect(assignedAtSend).toEqual([1,2,3,4,5]);
    expect(await db.message.count({where:{status:'SUBMITTED'}})).toBe(5);
    await drainJobs(100,0,undefined,()=>true,['ASSIGN','SEND']);
    expect(assignedAtSend).toHaveLength(5);
    // Independent writeback remains durable rather than delaying delivery.
    expect(await db.job.count({where:{type:'WRITEBACK',status:'PENDING'}})).toBe(5);
  });
  it('does not add a sleep after a send, and spaces only subsequent fast sends',async()=>{
    const f=await fixture();await synchronizeSheet(f.sheet.id,f.provider,{refreshQueued:false});
    await drainJobs(100,0,undefined,()=>true,['ASSIGN']);
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    const times:number[]=[];const send=DemoWhatsAppProvider.prototype.sendMessage;
    vi.spyOn(DemoWhatsAppProvider.prototype,'sendMessage').mockImplementation(async function(this:DemoWhatsAppProvider,input){times.push(Date.now());return send.call(this,input);});
    // This resolves without advancing the clock: the first send has no delay.
    await drainJobs(1,250,undefined,()=>true,['SEND']);expect(times).toHaveLength(1);
    const second=drainJobs(1,250,undefined,()=>true,['SEND']);
    await vi.waitFor(()=>expect(times).toHaveLength(2));await second;
    expect(times[1]-times[0]).toBeGreaterThanOrEqual(250);
  });
});
