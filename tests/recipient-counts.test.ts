import {afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '@/lib/db';
import {assignLead,dispatchMessage,synchronizeSheet} from '@/lib/engine';
import {simpleAction} from '@/lib/simple';
import {clearTestModels} from './database-fixture';
import type {SourceRow} from '@/lib/google';

beforeEach(async()=>{
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','User','Sender','Job','AuditLog','Setting']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Count tests'},update:{}});
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterAll(()=>db.$disconnect());
async function fixture(){
  const admin=await db.user.create({data:{organizationId:'legacy',name:'Admin',email:'counts@test.invalid',passwordHash:'unused',role:'SUPER_ADMIN'}});
  const sender=await db.sender.create({data:{organizationId:'legacy',name:'WhatsApp',provider:'WEB',status:'CONNECTED'}});
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Leads',project:'Project',spreadsheetId:'counts-test-source',connectionType:'SIMPLE_APPS_SCRIPT',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{enabled:false,senderId:sender.id,template:'Lead'}}}});
  const people=[{name:'First person',phone:'+919876543210',leadCount:2},{name:'Second person',phone:'+919876543211',leadCount:1}];
  const select=(recipients:unknown)=>simpleAction(['sheets',sheet.id,'recipients'],'PUT',new Request('http://localhost/api/simple',{method:'PUT',body:JSON.stringify({recipients})}),admin);
  const rows:SourceRow[]=Array.from({length:6},(_,index)=>({stableId:`lead-${index}`,row:index+2,values:{customerName:`Customer ${index}`,mobile:`+91980000000${index}`}}));
  await synchronizeSheet(sheet.id,{read:vi.fn(async()=>rows),write:vi.fn()});
  const leads=await db.lead.findMany({where:{sheetId:sheet.id},orderBy:{sourceRow:'asc'}});
  const queued=()=>db.message.findMany({where:{lead:{sheetId:sheet.id},status:'QUEUED'},orderBy:{lead:{sourceRow:'asc'}}});
  return {admin,sheet,people,select,leads,queued};
}
describe('per-recipient lead counts',()=>{
  it('saves 2:1 and continues the consecutive cycle from its persisted position after pause and an unchanged save',async()=>{
    const f=await fixture();await f.select(f.people);
    for(const lead of f.leads.slice(0,2))await assignLead(lead.id);
    const before=await db.distributionRule.findUniqueOrThrow({where:{sheetId:f.sheet.id}});expect(before.cursor).toBe(2);
    await simpleAction(['sheets',f.sheet.id,'pause'],'PUT',new Request('http://localhost',{method:'PUT',body:JSON.stringify({enabled:false})}),f.admin);
    await f.select(f.people);expect((await db.distributionRule.findUniqueOrThrow({where:{sheetId:f.sheet.id}})).cursor).toBe(before.cursor);
    for(const lead of f.leads.slice(2))await assignLead(lead.id);
    const [a,b]=f.people.map(p=>p.phone);expect((await f.queued()).map(m=>m.recipient)).toEqual([a,a,b,a,a,b]);
    const state=await simpleAction(['state'],'GET',new Request('http://localhost'),f.admin) as any;
    expect(state.sheets[0].recipients).toEqual(f.people);
  });
  it('applies changed counts to unsent leads while preserving a confirmed send and preventing its reassignment',async()=>{
    const f=await fixture();await f.select(f.people);for(const lead of f.leads)await assignLead(lead.id);
    const first=(await f.queued())[0];const send=vi.fn(async()=>({id:'confirmed-count-message',status:'SUBMITTED' as const}));
    await dispatchMessage(first.id,{sendMessage:send} as never);
    const changed=[{...f.people[0],leadCount:1},{...f.people[1],leadCount:2}];await f.select(changed);
    expect(await assignLead(f.leads[0].id)).toMatchObject({assigned:false,reason:'Already sent'});
    for(const lead of f.leads.slice(1))await assignLead(lead.id);
    const [a,b]=f.people.map(p=>p.phone);expect((await f.queued()).map(m=>m.recipient)).toEqual([a,b,b,a,b]);
    expect((await db.message.findUniqueOrThrow({where:{id:first.id}})).status).toBe('SUBMITTED');expect(send).toHaveBeenCalledOnce();
  });
  it('keeps older recipient requests compatible by assigning one lead per turn',async()=>{
    const f=await fixture();await f.select(f.people.map(({leadCount:_,...person})=>person));for(const lead of f.leads)await assignLead(lead.id);
    const [a,b]=f.people.map(p=>p.phone);expect((await f.queued()).map(m=>m.recipient)).toEqual([a,b,a,b,a,b]);
  });
  it.each([0,-1,1.5,1001,'2',null])('rejects invalid count %j without starting sending',async leadCount=>{
    const f=await fixture();await expect(f.select([{...f.people[0],leadCount}])).rejects.toThrow();
    expect((await db.distributionRule.findUniqueOrThrow({where:{sheetId:f.sheet.id}})).enabled).toBe(false);expect(await db.message.count()).toBe(0);
  });
});
