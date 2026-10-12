import { clearTestModels } from './database-fixture';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const cookieStore=vi.hoisted(()=>new Map<string,string>());
vi.mock('next/headers',()=>({cookies:async()=>({
  get:(key:string)=>cookieStore.has(key)?{value:cookieStore.get(key)}:undefined,
  set:(key:string,value:string)=>cookieStore.set(key,value),
  delete:(key:string)=>cookieStore.delete(key),
})}));
import { GET, POST, PUT } from '@/app/api/[...path]/route';
import { db } from '@/lib/db';
import { registerOrganization, organizationSettingKey } from '@/lib/organizations';
import { simpleAction } from '@/lib/simple';
import { employeeScope, leadScope, sheetScope } from '@/lib/permissions';
import { allowedStatuses, assignLead, dispatchMessage, enqueue } from '@/lib/engine';
import { googleToken } from '@/lib/google';
import { encrypt, verifyPassword } from '@/lib/security';
import { DEFAULT_TEMPLATE } from '@/lib/validation';
import { DemoWhatsAppProvider } from '@/lib/whatsapp';

const password='SeparateWorkspace!2026';
async function request(route:string,method='GET',body?:unknown){
  const req=new Request(`http://localhost:3000/api/${route}`,{method,headers:{origin:'http://localhost:3000','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return (method==='GET'?GET:method==='PUT'?PUT:POST)(req,{params:Promise.resolve({path:route.split('/')})});
}
async function fixture(){
  const a=await registerOrganization({name:'Manager One',organizationName:'Agency One',email:'one@example.test',password});
  const b=await registerOrganization({name:'Manager Two',organizationName:'Agency Two',email:'two@example.test',password});
  const senderA=await db.sender.create({data:{organizationId:a.organizationId,name:'One WhatsApp',provider:'WEB',status:'CONNECTED',qrCode:'one-qr'}});
  const senderB=await db.sender.create({data:{organizationId:b.organizationId,name:'Two WhatsApp',provider:'WEB',status:'CONNECTED',qrCode:'two-qr'}});
  const makeSheet=(organizationId:string,senderId:string,name:string)=>db.sheet.create({data:{organizationId,name,project:name,spreadsheetId:'same-sheet',worksheetId:0,connectionType:'SIMPLE_PUBLIC',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{senderId,enabled:false,template:DEFAULT_TEMPLATE}}}});
  const sheetA=await makeSheet(a.organizationId,senderA.id,'One leads');
  const sheetB=await makeSheet(b.organizationId,senderB.id,'Two leads');
  for(const [sheet,label]of [[sheetA,'One'],[sheetB,'Two']] as const)await db.lead.create({data:{sheetId:sheet.id,customerName:label,mobile:'+919800000000',project:label,stableSourceId:'source',sourceRow:2,sourceFingerprint:label}});
  for(const [sender,label]of [[senderA,'One'],[senderB,'Two']] as const)await db.setting.create({data:{key:`whatsapp-contacts:${sender.id}`,value:{contacts:[{name:label,phone:'+919876543210'}]}}});
  await db.googleCredential.create({data:{organizationId:b.organizationId,label:'Two Google',type:'OAUTH',encryptedValue:encrypt('{}')}});
  return {a,b,senderA,senderB,sheetA,sheetB};
}
beforeEach(async()=>{
  vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.stubEnv('WHATSAPP_LOGIN_MODE','qr');cookieStore.clear();
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.deleteMany({where:{id:{not:'legacy'}}});
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterAll(()=>db.$disconnect());

describe('separate organisation accounts',()=>{
  it('registers an owner and organisation together, hashes the password, and rejects duplicate emails without orphan organisations',async()=>{
    const response=await request('auth/register','POST',{name:'New Owner',organizationName:'New Agency',email:'OWNER@example.test',password,organizationId:'legacy',role:'EXECUTIVE'});
    expect(response.status).toBe(201);
    const user=await db.user.findUniqueOrThrow({where:{email:'owner@example.test'}});
    expect(user.organizationId).not.toBe('legacy');expect(user.role).toBe('SUPER_ADMIN');
    expect(verifyPassword(password,user.passwordHash)).toBe(true);
    const me=await (await request('auth/me')).json();expect(me.data.organizationId).toBe(user.organizationId);expect(me.data.passwordHash).toBeUndefined();
    const duplicate=await request('auth/register','POST',{name:'Another Owner',organizationName:'Another Agency',email:'owner@example.test',password});
    expect(duplicate.status).toBe(409);expect(await db.organization.count()).toBe(2);
  });
  it('requires authentication and validates signup before creating data',async()=>{
    expect((await request('simple/state')).status).toBe(401);
    expect((await request('auth/register','POST',{name:'Owner',organizationName:'Agency',email:'bad',password:'short'})).status).toBe(400);
    expect(await db.user.count()).toBe(0);
  });
  it('gives each login only its sheets, WhatsApp QR, contacts, and Google credentials',async()=>{
    const f=await fixture();
    const state=await simpleAction(['state'],'GET',new Request('http://localhost'),f.a) as any;
    expect(state.organization.name).toBe('Agency One');expect(state.sheets.map((s:any)=>s.id)).toEqual([f.sheetA.id]);expect(state.account).toMatchObject({id:f.senderA.id,qrCode:'one-qr'});
    expect(await simpleAction(['contacts'],'GET',new Request('http://localhost'),f.a)).toMatchObject({contacts:[{name:'One'}]});
    expect(await simpleAction(['google'],'GET',new Request('http://localhost'),f.a)).toMatchObject({credentials:[],serviceAccountConfigured:false});
    await request('auth/login','POST',{email:f.a.email,password});
    const own=await (await request('workspace')).json();expect(own.data.senders.map((s:any)=>s.id)).toEqual([f.senderA.id]);expect(own.data.credentials).toEqual([]);
    expect((await (await request('users')).json()).data.map((u:any)=>u.id)).toEqual([f.a.id]);
    expect((await (await request('leads')).json()).data.items.map((l:any)=>l.customerName)).toEqual(['One']);
    await request('auth/logout','POST');expect((await request('auth/me')).status).toBe(401);
    await request('auth/login','POST',{email:f.b.email,password});
    const other=await (await request('simple/state')).json();expect(other.data.account.id).toBe(f.senderB.id);expect(other.data.sheets.map((s:any)=>s.id)).toEqual([f.sheetB.id]);
  });
  it('blocks guessed foreign resource IDs through both API surfaces',async()=>{
    const f=await fixture();await request('auth/login','POST',{email:f.a.email,password});
    for(const route of [`sheets/${f.sheetB.id}`,`whatsapp/${f.senderB.id}/qr`])expect((await request(route)).status).toBe(404);
    expect((await request(`simple/sheets/${f.sheetB.id}/pause`,'PUT',{enabled:false})).status).toBe(404);
    expect((await request(`simple/sheets/${f.sheetB.id}/recipients`,'PUT',{recipients:[{name:'Wrong',phone:'+919876543210'}]})).status).toBe(404);
    expect((await request(`distribution/${f.sheetA.id}`,'PUT',{mode:'MANUAL',enabled:false,senderId:f.senderB.id,template:DEFAULT_TEMPLATE,recipients:[]})).status).toBe(400);
    const credential=await db.googleCredential.findFirstOrThrow();
    await expect(googleToken(credential.id,f.a.organizationId)).rejects.toThrow(/credential/);
    await expect(googleToken(null,f.a.organizationId)).rejects.toThrow(/organisation/);
    expect((await request('sheets/inspect','POST',{spreadsheetId:'same-sheet',credentialId:credential.id})).status).toBe(400);
    expect((await request('sheets/connect','POST',{name:'Foreign credentials',project:'Test',spreadsheetId:'another-sheet',worksheetId:0,worksheetName:'Sheet1',connectionType:'DEMO',credentialId:credential.id,columnMapping:{customerName:'Name',mobile:'Phone',leadId:'ID'},managedColumnsApproved:false})).status).toBe(400);
    expect(await db.sheet.count()).toBe(2);
    expect((await request('users','POST',{name:'Bad Manager',email:'bad@example.test',password,role:'MANAGER',sheetIds:[f.sheetB.id]})).status).toBe(404);
    expect(await db.user.count()).toBe(2);
  });
  it('isolates recipients with the same phone number and enqueues the correct WhatsApp connection',async()=>{
    const f=await fixture();
    const update=(user:typeof f.a,sheetId:string,name:string)=>simpleAction(['sheets',sheetId,'recipients'],'PUT',new Request('http://localhost',{method:'PUT',body:JSON.stringify({recipients:[{name,phone:'+919876543210'}]})}),user);
    await update(f.a,f.sheetA.id,'One Sales');await update(f.b,f.sheetB.id,'Two Sales');
    const employees=await db.employee.findMany({orderBy:{name:'asc'}});expect(employees).toHaveLength(2);expect(employees.map(e=>e.name)).toEqual(['One Sales','Two Sales']);
    for(const [user,sheet,sender]of [[f.a,f.sheetA,f.senderA],[f.b,f.sheetB,f.senderB]] as const){
      const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id}});await assignLead(lead.id);
      const message=await db.message.findFirstOrThrow({where:{leadId:lead.id}});expect(message.senderId).toBe(sender.id);
      expect(await db.job.findFirstOrThrow({where:{entityId:message.id}})).toMatchObject({organizationId:user.organizationId,type:'SEND'});
      expect(await db.employee.count({where:employeeScope(user)})).toBe(1);
    }
  });
  it.each(['background','qr','native'])('starts a visible %s connection for each organisation and scopes connection jobs',async mode=>{
    vi.stubEnv('WHATSAPP_LOGIN_MODE',mode);
    await db.setting.create({data:{key:'simple:worker',value:{at:Date.now()}}});
    const a=await registerOrganization({name:'Owner One',organizationName:'Agency One',email:'one@example.test',password});
    const b=await registerOrganization({name:'Owner Two',organizationName:'Agency Two',email:'two@example.test',password});
    await simpleAction(['whatsapp','connect'],'POST',new Request('http://localhost'),a);
    await simpleAction(['whatsapp','connect'],'POST',new Request('http://localhost'),b);
    const senders=await db.sender.findMany();expect(senders).toHaveLength(2);expect(new Set(senders.map(s=>s.id)).size).toBe(2);
    for(const user of [a,b]){
      const sender=senders.find(s=>s.organizationId===user.organizationId)!;
      expect(sender.status).toBe('CONNECTING');
      expect(await db.job.findFirstOrThrow({where:{organizationId:user.organizationId}})).toMatchObject({entityId:sender.id,type:'CONNECT'});
      await simpleAction(['whatsapp','disconnect'],'POST',new Request('http://localhost'),user);
      expect(await db.job.findFirstOrThrow({where:{organizationId:user.organizationId,type:'DISCONNECT'}})).toMatchObject({entityId:sender.id});
    }
  });
  it('reports a missing or stale worker without creating an account or queuing a connection',async()=>{
    const owner=await registerOrganization({name:'Owner One',organizationName:'Agency One',email:'one@example.test',password});
    await request('auth/login','POST',{email:owner.email,password});
    for(const stale of [false,true]){
      if(stale)await db.setting.create({data:{key:'simple:worker',value:{at:Date.now()-60000}}});
      const response=await request('simple/whatsapp/connect','POST');
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatchObject({code:'WHATSAPP_WORKER_OFFLINE',message:expect.stringContaining('Start SmartLead.cmd')});
      expect(await db.sender.count()).toBe(0);expect(await db.job.count()).toBe(0);
    }
    const state=await (await request('simple/state')).json();
    expect(state.data).toMatchObject({workerRunning:false,workerMessage:expect.stringContaining('Start SmartLead.cmd')});
  });
  it('gives hosted users server instructions and blocks the management connection API when offline',async()=>{
    const f=await fixture();await request('auth/login','POST',{email:f.a.email,password});
    const response=await request(`whatsapp/${f.senderA.id}/connect`,'POST');
    expect(response.status).toBe(503);expect((await response.json()).error.code).toBe('WHATSAPP_WORKER_OFFLINE');
    expect(await db.job.count()).toBe(0);
    vi.stubEnv('APP_URL','https://smartlead.example.com');
    await expect(simpleAction(['whatsapp','connect'],'POST',new Request('https://smartlead.example.com'),f.a)).rejects.toMatchObject({status:503,message:expect.stringContaining('hosting server')});
    const state=await simpleAction(['state'],'GET',new Request('https://smartlead.example.com'),f.a) as {workerMessage:string};
    expect(state.workerMessage).not.toContain('.cmd');
  });
  it('isolates custom statuses, settings, and job lists',async()=>{
    const f=await fixture();
    const foreignJob=await enqueue(db,'CONNECT',f.senderB.id,'two-connect');
    await db.job.update({where:{id:foreignJob.id},data:{status:'DEAD'}});
    await request('auth/login','POST',{email:f.a.email,password});
    expect((await (await request('jobs')).json()).data).toEqual([]);
    expect((await request(`jobs/${foreignJob.id}`,'POST',{})).status).toBe(400);
    const settings={name:'One renamed',timezone:'Asia/Kolkata',statuses:['One status']};
    expect((await request('settings','PUT',{...settings,sheetId:f.sheetB.id})).status).toBe(404);
    expect((await request('settings','PUT',settings)).status).toBe(200);
    expect(await allowedStatuses(f.sheetA.id)).toEqual(['One status']);expect(await allowedStatuses(f.sheetB.id)).not.toContain('One status');
    const state=await (await request('workspace')).json();expect(state.data.settings.workspace.name).toBe('One renamed');
    expect(await db.setting.findUnique({where:{key:organizationSettingKey(f.b.organizationId,'workspace')}})).toBeNull();
    expect(await db.sheet.count({where:sheetScope(f.a)})).toBe(1);expect(await db.lead.count({where:leadScope(f.b)})).toBe(1);
  });
  it('refuses a corrupted cross-organisation sender in the worker before submission',async()=>{
    const f=await fixture();const employee=await db.employee.create({data:{organizationId:f.a.organizationId,name:'Sales',phone:'+919876543210',projects:[]}});
    await db.distributionRule.update({where:{sheetId:f.sheetA.id},data:{enabled:true,recipients:{create:{employeeId:employee.id}}}});
    const lead=await db.lead.findFirstOrThrow({where:{sheetId:f.sheetA.id}});await assignLead(lead.id);
    const message=await db.message.findFirstOrThrow({where:{leadId:lead.id}});
    await db.message.update({where:{id:message.id},data:{senderId:f.senderB.id}});
    const provider=new DemoWhatsAppProvider(f.senderB);const send=vi.spyOn(provider,'sendMessage');
    await expect(dispatchMessage(message.id,provider)).rejects.toThrow(/organisation/);expect(send).not.toHaveBeenCalled();
  });
});
