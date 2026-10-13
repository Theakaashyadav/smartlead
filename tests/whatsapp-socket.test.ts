import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestModels } from './database-fixture';
const mocks=vi.hoisted(()=>({make:vi.fn(),instances:[] as any[]}));
vi.mock('baileys',async importOriginal=>({...await importOriginal<typeof import('baileys')>(),default:mocks.make}));
import { db } from '@/lib/db';
import { SocketWhatsAppProvider, closeSocketWhatsApp } from '@/lib/whatsapp-socket';
import { socketAuthState } from '@/lib/whatsapp-socket-auth';
import { UncertainDelivery, whatsappProvider } from '@/lib/whatsapp';
import { assignLead, dispatchMessage, synchronizeSheet } from '@/lib/engine';
import { decrypt } from '@/lib/security';
import { SIMPLE_TEMPLATE } from '@/lib/simple-shared';
import { PublicSheetsProvider } from '@/lib/public-sheets';

beforeEach(async()=>{
  vi.stubEnv('WHATSAPP_LOGIN_MODE','socket');
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','Sender','Job','Setting']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Test organisation'},update:{}});
  mocks.instances.length=0;mocks.make.mockReset();
  mocks.make.mockImplementation((options:any)=>{
    const socket={options,ev:new EventEmitter(),user:{id:'919876543210:1@s.whatsapp.net'},
      end:vi.fn(),logout:vi.fn().mockResolvedValue(undefined),
      signalRepository:{lidMapping:{getPNForLID:vi.fn().mockResolvedValue('919876543212@s.whatsapp.net')}},
      onWhatsApp:vi.fn(async(number:string)=>[{exists:true,jid:`${number}@s.whatsapp.net`}]),
      sendMessage:vi.fn(async(_to:string,_body:unknown,opts:any)=>({key:{id:opts.messageId}})),
    };mocks.instances.push(socket);return socket;
  });
});
afterEach(async()=>{await closeSocketWhatsApp();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
afterAll(()=>db.$disconnect());

async function fixture(){
  const sender=await db.sender.create({data:{organizationId:'legacy',name:'Socket account',provider:'WEB'}});
  const provider=whatsappProvider(sender) as SocketWhatsAppProvider;
  await provider.connect();return {sender,provider,socket:mocks.instances.at(-1)};
}
async function linked(){
  const f=await fixture();
  f.socket.ev.emit('creds.update',{registered:true});
  f.socket.ev.emit('connection.update',{connection:'open'});
  await vi.waitFor(async()=>expect(await f.provider.getConnectionStatus()).toBe('CONNECTED'));
  return f;
}
async function source(senderId:string){
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
  const employees=await Promise.all([1,2].map(i=>db.employee.create({data:{organizationId:'legacy',name:`Employee ${i}`,phone:`+91987654321${i}`,projects:[]}})));
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Test source',project:'Sales',spreadsheetId:'public-socket-test-spreadsheet',connectionType:'SIMPLE_PUBLIC',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{enabled:true,senderId,mode:'ROUND_ROBIN',template:SIMPLE_TEMPLATE,recipients:{create:employees.map((employee,position)=>({employeeId:employee.id,position}))}}}}});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('Name,Phone\nLead one,919800000001\nLead two,919800000002',{headers:{'content-type':'text/csv'}})));
  await synchronizeSheet(sheet.id);
  for(const lead of await db.lead.findMany({where:{sheetId:sheet.id},orderBy:{sourceRow:'asc'}}))await assignLead(lead.id);
  return {sheet,employees,messages:await db.message.findMany({where:{senderId},orderBy:{queuedAt:'asc'}})};
}

describe('WhatsApp QR login without Chromium',()=>{
  it('reuses verified recipient numbers and sends the clickable URL without waiting for a preview',async()=>{
    const f=await linked();
    for(let i=0;i<3;i++)await f.provider.sendMessage({to:'+919876543211',body:'Lead https://example.com/feedback/private-token',parameters:[]});
    expect(f.socket.onWhatsApp).toHaveBeenCalledOnce();
    expect(f.socket.sendMessage).toHaveBeenCalledTimes(3);
    expect(f.socket.sendMessage.mock.calls[0][1]).toEqual({text:'Lead https://example.com/feedback/private-token',linkPreview:null});
    expect(f.socket.options.keepAliveIntervalMs).toBe(15000);
  });
  it('keeps connection events responsive while contact synchronization is blocked',async()=>{
    const f=await linked();let finish!:(phone:string)=>void;
    f.socket.signalRepository.lidMapping.getPNForLID.mockImplementation(()=>new Promise<string>(resolve=>{finish=resolve;}));
    f.socket.ev.emit('contacts.upsert',[{id:'123@lid',name:'Pending contact'}]);
    await vi.waitFor(()=>expect(f.socket.signalRepository.lidMapping.getPNForLID).toHaveBeenCalled());
    try{
      f.socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
      await vi.waitFor(()=>expect(mocks.make).toHaveBeenCalledTimes(2));
      mocks.instances[1].ev.emit('connection.update',{connection:'open'});
      await vi.waitFor(async()=>expect(await f.provider.getConnectionStatus()).toBe('CONNECTED'));
    }finally{finish('919876543212@s.whatsapp.net');}
  });
  it('releases disconnected-send retry delays as soon as WhatsApp reconnects',async()=>{
    const f=await linked();const data=await source(f.sender.id);
    const ids=data.messages.map(message=>message.id);
    await db.job.updateMany({where:{type:'SEND',entityId:{in:ids}},data:{runAt:new Date(Date.now()+60000)}});
    f.socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
    await vi.waitFor(()=>expect(mocks.make).toHaveBeenCalledTimes(2));
    mocks.instances[1].ev.emit('connection.update',{connection:'open'});
    await vi.waitFor(async()=>expect(await db.job.count({where:{type:'SEND',entityId:{in:ids},runAt:{lte:new Date()}}})).toBe(2));
    expect(await db.message.count({where:{id:{in:ids},status:'QUEUED'}})).toBe(2);
    expect(f.socket.sendMessage).not.toHaveBeenCalled();
  });
  it('shows the QR in the existing account state and deduplicates concurrent connect requests',async()=>{
    const f=await fixture();await Promise.all([f.provider.connect(),f.provider.connect()]);
    expect(mocks.make).toHaveBeenCalledOnce();
    f.socket.ev.emit('connection.update',{qr:'private-pairing-qr'});
    await vi.waitFor(async()=>expect((await db.sender.findUniqueOrThrow({where:{id:f.sender.id}})).status).toBe('WAITING_QR'));
    expect(await f.provider.getQRCode()).toMatch(/^data:image\/png;base64,/);
  });
  it('stores contact updates without including groups or the linked account itself',async()=>{
    const f=await linked();
    f.socket.ev.emit('contacts.upsert',[{id:'919876543211@s.whatsapp.net',name:'First'},{id:'123@g.us',name:'Group'},{id:f.socket.user.id,name:'Self'},{id:'123@lid',name:'Second'}]);
    await vi.waitFor(async()=>expect((await f.provider.refreshContacts()).map(c=>c.phone).sort()).toEqual(['+919876543211','+919876543212']));
  });
  it('restores authentication after a worker restart without logging out the linked device',async()=>{
    const f=await linked();await closeSocketWhatsApp();
    expect(f.socket.logout).not.toHaveBeenCalled();
    await f.provider.connect();expect(mocks.instances[1].options.auth.creds.registered).toBe(true);
    expect(mocks.instances[1].options.auth.creds.noiseKey).toEqual(f.socket.options.auth.creds.noiseKey);
  });
  it('reconnects after pairing requires a restart, and ignores events from the old socket',async()=>{
    const f=await linked();f.socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
    await vi.waitFor(()=>expect(mocks.make).toHaveBeenCalledTimes(2));
    f.socket.ev.emit('connection.update',{qr:'stale-qr'});
    mocks.instances[1].ev.emit('connection.update',{connection:'open'});
    await vi.waitFor(async()=>expect((await db.sender.findUniqueOrThrow({where:{id:f.sender.id}}))).toMatchObject({status:'CONNECTED',qrCode:null}));
  });
  it('removes only the selected connection on explicit logout',async()=>{
    const f=await linked();const other=await socketAuthState('another-account');await other.saveCreds();
    await f.provider.disconnect();expect(f.socket.logout).toHaveBeenCalledOnce();
    expect(await db.setting.count({where:{key:{startsWith:`whatsapp-socket-auth:${f.sender.id}:`}}})).toBe(0);
    expect(await db.setting.count({where:{key:{startsWith:'whatsapp-socket-auth:another-account:'}}})).toBe(1);
  });
  it('imports public sheet leads, rotates recipients, and submits each lead once through the new connection',async()=>{
    const f=await linked();const data=await source(f.sender.id);
    for(const message of data.messages)await dispatchMessage(message.id);
    expect(f.socket.sendMessage).toHaveBeenCalledTimes(2);
    expect(new Set(f.socket.sendMessage.mock.calls.map((call:any[])=>call[0]))).toEqual(new Set(data.employees.map(e=>e.phone.slice(1)+'@s.whatsapp.net')));
    expect(await db.message.count({where:{senderId:f.sender.id,status:'SUBMITTED'}})).toBe(2);
    await synchronizeSheet(data.sheet.id);
    for(const message of data.messages)await dispatchMessage(message.id);
    expect(await db.lead.count({where:{sheetId:data.sheet.id}})).toBe(2);expect(f.socket.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('holds uncertain sends and reconciles only an exact reserved message ID, recipient and body',async()=>{
    const f=await linked();const data=await source(f.sender.id);const message=data.messages[0];
    f.socket.sendMessage.mockRejectedValueOnce(new Error('connection interrupted'));
    await dispatchMessage(message.id);await dispatchMessage(message.id);
    const failed=await db.message.findUniqueOrThrow({where:{id:message.id}});
    expect(failed).toMatchObject({status:'FAILED',uncertain:true});expect(failed.providerMessageId).toMatch(/^socket:/);
    expect(f.socket.sendMessage).toHaveBeenCalledOnce();
    const key={id:failed.providerMessageId!.split(':').at(-1),fromMe:true,remoteJid:message.recipient.slice(1)+'@s.whatsapp.net'};
    f.socket.ev.emit('messages.upsert',{messages:[{key,message:{conversation:'Different body'}}]});
    await new Promise(resolve=>setTimeout(resolve,30));expect((await db.message.findUniqueOrThrow({where:{id:message.id}})).uncertain).toBe(true);
    f.socket.ev.emit('messages.upsert',{messages:[{key,message:{conversation:decrypt(message.encryptedBody)}}]});
    await vi.waitFor(async()=>expect((await db.message.findUniqueOrThrow({where:{id:message.id}}))).toMatchObject({status:'SUBMITTED',uncertain:false}));
    expect(f.socket.sendMessage).toHaveBeenCalledOnce();
  });
  it('rejects an unregistered recipient before submission and preserves uncertain network outcomes',async()=>{
    const f=await linked();f.socket.onWhatsApp.mockResolvedValueOnce([]);
    await expect(f.provider.sendMessage({to:'+919876543211',body:'Lead',parameters:[]})).rejects.toThrow('not registered');
    expect(f.socket.sendMessage).not.toHaveBeenCalled();
    f.socket.sendMessage.mockRejectedValueOnce(new Error('timeout'));
    await expect(f.provider.sendMessage({to:'+919876543211',body:'Lead',parameters:[]})).rejects.toBeInstanceOf(UncertainDelivery);
  });
  it('keeps unsupported public-sheet writes from launching Chromium in browserless mode',async()=>{
    const f=await linked();const data=await source(f.sender.id);
    await expect(new PublicSheetsProvider().write(data.sheet,'source',null,{status:'NEW'})).rejects.toMatchObject({code:'SHEET_WRITEBACK_UNAVAILABLE'});
  });
});
