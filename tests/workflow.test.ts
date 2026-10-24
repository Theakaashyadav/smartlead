import { clearTestModels } from './database-fixture';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { AppError, checkOrigin, decrypt, encrypt, hash, passwordHash, signedFeedbackToken, verifyFeedbackSignature, verifyPassword } from '@/lib/security';
import { chooseRecipients } from '@/lib/distribution';
import { DEFAULT_TEMPLATE, feedbackSchema, MANAGED, ruleSchema } from '@/lib/validation';
import { assignLead, dispatchMessage, drainJobs, enqueue, getFeedbackAccess, saveFeedback, synchronizeSheet, writebackLead } from '@/lib/engine';
import { DemoSheetsProvider, GoogleSheetsProvider, type SourceRow, type SheetProvider } from '@/lib/google';
import { DemoWhatsAppProvider, UncertainDelivery, WebWhatsAppProvider, registerWebClient } from '@/lib/whatsapp';
import { leadScope } from '@/lib/permissions';
import { workspace } from '@/lib/analytics';
import { safeCell } from '@/lib/reports';
import { detectColumns, SIMPLE_TEMPLATE, spreadsheetIdentity } from '@/lib/simple-shared';
import { simpleAction } from '@/lib/simple';
import { NativeWhatsAppProvider, detachNativeWhatsApp, nativeBrowserEndpoint, nativeProfilePath, whatsappBrowserArguments } from '@/lib/whatsapp-native';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectPublicSpreadsheet, parseSheetCSV, PublicSheetsProvider } from '@/lib/public-sheets';

const nativeMocks=vi.hoisted(()=>({connect:vi.fn(),instances:[] as any[]}));
vi.mock('puppeteer',()=>({connect:nativeMocks.connect}));
vi.mock('whatsapp-web.js',async()=>{
  const {EventEmitter}=await import('node:events');
  class Client extends EventEmitter{
    info={wid:{user:'919876543210'}};pupPage:any;pupBrowser:any;
    constructor(){super();nativeMocks.instances.push(this);}
    initialize=vi.fn();
    async inject(){this.emit('ready');}
    async getState(){return 'CONNECTED';}
    async getContacts(){return [];}
    async getChats(){return [];}
    async getNumberId(number:string){return {_serialized:`${number}@c.us`};}
    sendMessage=vi.fn(async()=>({id:{_serialized:'background-test-message'}}));
    async logout(){}
  }
  return {Client,default:{Client}};
});

vi.mock('google-auth-library',()=>({GoogleAuth:class{async getAccessToken(){return 'test-google-token';}},OAuth2Client:class{}}));
async function fixture(mode='ROUND_ROBIN'){
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
  const admin=await db.user.create({data:{organizationId:'legacy',id:'admin',name:'Admin',email:'admin@test.invalid',passwordHash:passwordHash('ValidPassword!12'),role:'SUPER_ADMIN'}});
  for(let i=0;i<3;i++)await db.employee.create({data:{organization:{connect:{id:'legacy'}},id:`e${i}`,name:`Employee ${i}`,phone:`+91987654321${i}`,projects:[],dailyLimit:50,capacity:100,user:{create:{organizationId:'legacy',id:`u${i}`,name:`Employee ${i}`,email:`e${i}@test.invalid`,passwordHash:passwordHash('ValidPassword!12'),role:'EXECUTIVE'}}}});
  const sender=await db.sender.create({data:{organizationId:'legacy',id:'sender',name:'Demo sender',provider:'DEMO',status:'CONNECTED'}});
  const sheet=await db.sheet.create({data:{organizationId:'legacy',id:'sheet',name:'Test source',project:'Noida',spreadsheetId:'test-spreadsheet',connectionType:'DEMO',managedColumnsApproved:true,columnMapping:{leadId:'ID',customerName:'Name',mobile:'Phone',...MANAGED},rule:{create:{mode,senderId:sender.id,template:DEFAULT_TEMPLATE,recipients:{create:[0,1,2].map(i=>({employeeId:`e${i}`,position:i,weight:[50,30,20][i]}))}}}}});
  const rows:SourceRow[]=Array.from({length:4},(_,i)=>({stableId:`source-${i}`,row:i+2,metadataId:100+i,values:{leadId:`source-${i}`,customerName:`Customer ${i}`,mobile:`+91980000000${i}`,project:'Noida',source:'Test'}}));
  await db.setting.create({data:{key:'demo-source:sheet',value:JSON.parse(JSON.stringify(rows))}});
  return {admin,sender,sheet,rows};
}
beforeEach(async()=>{
  await detachNativeWhatsApp();nativeMocks.instances.length=0;
  vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.stubEnv('WHATSAPP_LOGIN_MODE','native');
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
});
afterAll(()=>db.$disconnect());
describe('public Google Sheets links',()=>{
  const spreadsheetId='public-test-spreadsheet-123456789';
  const html='<title>Sales &amp; Leads - Google Drive</title><script>items.push({name: "Incoming", pageUrl: "https:\\/\\/docs.google.com\\/sheet", gid: "42", initialSheet: false});items.push({name: "Second\\x20tab", pageUrl: "https:\\/\\/docs.google.com\\/sheet", gid: "7", initialSheet: false});</script>';
  it('preserves quoted commas, newlines, escaped quotes, empty cells and phone text',()=>{
    expect(parseSheetCSV('\uFEFFName,Phone,Notes\r\n"A, B",00123456789,"Line one\nLine ""two"""\r\nC,+919876543210,')).toEqual([['Name','Phone','Notes'],['A, B','00123456789','Line one\nLine "two"'],['C','+919876543210','']]);
    expect(()=>parseSheetCSV('Name,Phone\n"Incomplete')).toThrow(/incomplete/);
  });
  it('inspects authenticated tabs and connects with Google credentials without changing source cells',async()=>{
    const {admin}=await fixture();
    const credential=await db.googleCredential.create({data:{organizationId:'legacy',label:'Google',type:'SERVICE_ACCOUNT',encryptedValue:encrypt('{}')}});
    const fetcher=vi.fn(async(url:string,init?:RequestInit)=>Response.json(url.includes('/values/')?{values:url.includes('1%3A1')?[['Name','Phone']]:[['Name','Phone'],['Customer','9876543210']]}:init?.body?{replies:[]}:{properties:{title:'Sales & Leads'},sheets:[{properties:{sheetId:42,title:'Incoming'}},{properties:{sheetId:7,title:'Second tab'}}]}));vi.stubGlobal('fetch',fetcher);
    const info=await simpleAction(['sheets','inspect'],'POST',new Request('http://localhost:3000',{method:'POST',body:JSON.stringify({url:`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=42`,credentialId:credential.id})}),admin) as any;
    expect(info).toMatchObject({title:'Sales & Leads',gid:42,tabs:[{id:42,name:'Incoming',headers:['Name','Phone']},{id:7,name:'Second tab'}]});
    const result=await simpleAction(['sheets'],'POST',new Request('http://localhost:3000',{method:'POST',body:JSON.stringify({spreadsheetId,worksheetId:42,credentialId:credential.id,columnMapping:{customerName:'Name',mobile:'Phone'}})}),admin) as {id:string};
    const sheet=await db.sheet.findUniqueOrThrow({where:{id:result.id},include:{rule:true}});expect(sheet).toMatchObject({connectionType:'SIMPLE_GOOGLE',credentialId:credential.id,managedColumnsApproved:false,worksheetId:42,worksheetName:'Incoming',rule:{enabled:false}});
    expect(await synchronizeSheet(sheet.id)).toMatchObject({imported:1});expect(await db.message.count({where:{lead:{sheetId:sheet.id}}})).toBe(0);
    for(const call of fetcher.mock.calls){expect(call[0]).toMatch(/^https:\/\/sheets\.googleapis\.com\//);expect(call[1]?.headers).toMatchObject({Authorization:'Bearer test-google-token'});}
    expect(fetcher.mock.calls.some(call=>call[0].includes('/values:batchUpdate'))).toBe(false);
    expect(await db.googleCredential.count()).toBe(1);
  });
  it('keeps source identities after edits and reordering, skips repeated phone rows and imports new leads',async()=>{
    await fixture();const sheet=await db.sheet.update({where:{id:'sheet'},data:{spreadsheetId,worksheetId:42,connectionType:'SIMPLE_PUBLIC',managedColumnsApproved:false,columnMapping:{customerName:'Name',mobile:'Phone'}}});
    let csv='Name,Phone\nFirst,9876543210\nSecond,+919876543211\nDuplicate,9876543210';vi.stubGlobal('fetch',vi.fn(async()=>new Response(csv,{headers:{'content-type':'text/csv'}})));
    expect(await synchronizeSheet(sheet.id)).toMatchObject({imported:2});const first=await db.lead.findFirstOrThrow({where:{customerName:'First'}});
    csv='Name,Phone\nSecond,+919876543211\nRenamed first,+91 98765 43210\nThird,+919876543212';
    expect(await synchronizeSheet(sheet.id)).toMatchObject({imported:1});expect(await db.lead.count()).toBe(3);expect(await db.lead.findUniqueOrThrow({where:{id:first.id}})).toMatchObject({customerName:'Renamed first',sourceRow:3,sourceDeleted:false});
    expect(await synchronizeSheet(sheet.id)).toMatchObject({imported:0});
  });
  it('rejects private sheets, HTML login pages and invalid worksheet IDs with a sharing instruction',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('Sign in',{status:403})));await expect(inspectPublicSpreadsheet(spreadsheetId)).rejects.toThrow(/Anyone with the link/);
    await fixture();const sheet=await db.sheet.findUniqueOrThrow({where:{id:'sheet'}});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}})));await expect(new PublicSheetsProvider().read({...sheet,spreadsheetId})).rejects.toThrow(/Anyone with the link/);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(html)));await expect(inspectPublicSpreadsheet(spreadsheetId,999)).rejects.toThrow(/worksheet.*not found/);
  });
  it('preserves existing public output values once and retains the conflict baseline after an upgrade',async()=>{
    await fixture();const sheet=await db.sheet.update({where:{id:'sheet'},data:{spreadsheetId,connectionType:'SIMPLE_PUBLIC',columnMapping:{customerName:'Name',mobile:'Phone'}}});
    let csv='Name,Phone,lead_status,shared to,Feedback\nCustomer,9876543210,BAD,Previous owner,Existing note';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(csv,{headers:{'content-type':'text/csv'}})));
    await synchronizeSheet(sheet.id);let lead=await db.lead.findFirstOrThrow();
    expect(lead).toMatchObject({status:'BAD',lastFeedback:'Existing note',managedSnapshot:{status:'BAD',sharedTo:'Previous owner',feedback:'Existing note',__publicFeedbackInitialized:'1'}});
    await db.lead.update({where:{id:lead.id},data:{managedSnapshot:{status:'',assignedEmployee:'',feedback:''},status:'New',lastFeedback:null}});
    await synchronizeSheet(sheet.id);lead=await db.lead.findFirstOrThrow();expect(lead.status).toBe('BAD');expect(lead.lastFeedback).toBe('Existing note');
    await assignLead(lead.id);const write=vi.fn<SheetProvider['write']>(async()=>{});await writebackLead(lead.id,{read:vi.fn(),write});
    expect(write.mock.calls[0][3]).toEqual({sentStatus:'',sharedTo:'',status:'BAD',feedback:'Existing note'});
    csv='Name,Phone,lead_status,shared to,Feedback\nCustomer,9876543210,External change,Other owner,External note';
    await synchronizeSheet(sheet.id);lead=await db.lead.findFirstOrThrow();expect(lead.status).toBe('BAD');expect(lead.lastFeedback).toBe('Existing note');expect(lead.managedSnapshot).toMatchObject({status:'BAD',__publicFeedbackInitialized:'1'});
    const assignment=await db.assignment.findFirstOrThrow();await saveFeedback(assignment.id,{status:'BAD',remarks:'Retain the original status',version:lead.version});
  });
  it('rejects repeated explicit lead IDs instead of merging separate source rows',async()=>{
    await fixture();const sheet=await db.sheet.findUniqueOrThrow({where:{id:'sheet'}});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('ID,Name,Phone\nsame,First,9876543210\nsame,Second,9876543211',{headers:{'content-type':'text/csv'}})));
    await expect(new PublicSheetsProvider().read({...sheet,spreadsheetId,columnMapping:{leadId:'ID',customerName:'Name',mobile:'Phone'}})).rejects.toThrow(/Duplicate source Lead IDs/);
  });
});
describe('original WhatsApp Web login',()=>{
  it('links and sends in a background browser without ever opening a desktop window',async()=>{
    vi.stubEnv('WHATSAPP_LOGIN_MODE','background');
    const id=`background-test-${process.pid}`;const profile=nativeProfilePath(id);await mkdir(profile,{recursive:true});await writeFile(path.join(profile,'DevToolsActivePort'),'43210\n/devtools/browser/background-browser');await writeFile(path.join(profile,'SmartLeadBrowserMode'),'background');
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({webSocketDebuggerUrl:'ws://127.0.0.1:43210/devtools/browser/background-browser'})));
    let signedIn=false;const qr='data:image/png;base64,original-site-canvas';const canvas={evaluate:vi.fn(async()=>qr),dispose:vi.fn()};
    const page={url:()=> 'https://web.whatsapp.com/',isClosed:()=>false,evaluate:vi.fn(async fn=>String(fn).includes('querySelector')?signedIn:undefined),$:vi.fn(async()=>canvas),createCDPSession:vi.fn(),bringToFront:vi.fn(),reload:vi.fn()};
    const duplicate={url:()=> 'https://web.whatsapp.com/',close:vi.fn(async()=>{})};
    const browser={connected:true,pages:async()=>[page,duplicate],newPage:vi.fn(),once:vi.fn(),disconnect:vi.fn(async()=>{}),close:vi.fn()};nativeMocks.connect.mockResolvedValue(browser);
    const sender=await db.sender.create({data:{organizationId:'legacy',id,name:'WhatsApp',provider:'WEB'}});const provider=new NativeWhatsAppProvider(sender);await provider.connect();
    await vi.waitFor(async()=>expect((await db.sender.findUniqueOrThrow({where:{id}})).status).toBe('WAITING_QR'));
    expect(await provider.getQRCode()).toBe(qr);expect(nativeMocks.instances).toHaveLength(0);expect(duplicate.close).toHaveBeenCalled();
    await provider.connect();expect(await provider.getQRCode()).toBe(qr);
    signedIn=true;await vi.waitFor(async()=>expect((await db.sender.findUniqueOrThrow({where:{id}})).status).toBe('CONNECTED'),{timeout:5000});
    expect(await provider.sendMessage({to:'+919876543211',body:'Test lead',parameters:[]})).toEqual({id:'background-test-message',status:'SUBMITTED'});expect(nativeMocks.instances[0].sendMessage).toHaveBeenCalledWith('919876543211@c.us','Test lead',{sendSeen:false});
    expect(page.createCDPSession).not.toHaveBeenCalled();expect(page.bringToFront).not.toHaveBeenCalled();expect(nativeMocks.instances[0].initialize).not.toHaveBeenCalled();expect(await provider.getQRCode()).toBeNull();
    const args=whatsappBrowserArguments(profile,true,true);expect(args).toContain('--headless=new');expect(args).not.toContain('--new-window');expect(args).not.toContain('--start-minimized');
    await detachNativeWhatsApp();expect(browser.close).not.toHaveBeenCalled();
  });
  it('loads valid contacts without serializing messages and tolerates an unresolved private ID',async()=>{
    const sender=await db.sender.create({data:{organizationId:'legacy',id:'contacts',name:'WhatsApp',provider:'WEB',status:'CONNECTED'}});
    const client={getState:async()=> 'CONNECTED',info:{wid:{user:'919876543210'}},getContacts:async()=>[
      {id:{_serialized:'919876543211@c.us'},number:'919876543211',name:'Saved contact'},
      {id:{_serialized:'broken@lid'},name:'Unresolved'},
      {id:{_serialized:'919876543210@c.us'},number:'919876543210',isMe:true}
    ],getChats:vi.fn().mockRejectedValue(new Error('Old message unavailable')),pupPage:{evaluate:vi.fn().mockResolvedValue([{id:'resolved@lid',number:'resolved',name:'Recent chat'}])},getContactLidAndPhone:vi.fn(async([id]:string[])=>{if(id==='broken@lid')throw new Error('Private ID unavailable');return[{lid:id,pn:'919876543212@c.us'}];})};
    registerWebClient(sender.id,client as unknown as import('whatsapp-web.js').Client);
    try{
      const contacts=await new WebWhatsAppProvider(sender).refreshContacts();
      expect(contacts).toEqual([{phone:'+919876543212',name:'Recent chat'},{phone:'+919876543211',name:'Saved contact'}]);expect(client.getChats).not.toHaveBeenCalled();
      const cached=await db.setting.findUniqueOrThrow({where:{key:'whatsapp-contacts:contacts'}});expect(cached.value).toMatchObject({contacts,error:null});
    }finally{registerWebClient(sender.id,null);}
  });
  it('keeps saved contacts when chat metadata is temporarily unavailable',async()=>{
    const sender=await db.sender.create({data:{organizationId:'legacy',id:'contacts-fallback',name:'WhatsApp',provider:'WEB',status:'CONNECTED'}});
    const client={getState:async()=> 'CONNECTED',info:{wid:{user:'919876543210'}},getContacts:async()=>[{id:{_serialized:'919876543211@c.us'},number:'919876543211',name:'Saved contact'}],pupPage:{evaluate:vi.fn().mockRejectedValue(new Error('Chats still syncing'))}};
    registerWebClient(sender.id,client as unknown as import('whatsapp-web.js').Client);
    try{expect(await new WebWhatsAppProvider(sender).refreshContacts()).toEqual([{phone:'+919876543211',name:'Saved contact'}]);}
    finally{registerWebClient(sender.id,null);}
  });
  it('waits for native login, attaches to the same page, and leaves the browser open on detach',async()=>{
    const id=`native-test-${process.pid}`;const profile=nativeProfilePath(id);await mkdir(profile,{recursive:true});await writeFile(path.join(profile,'DevToolsActivePort'),'43210\n/devtools/browser/test-browser');
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({webSocketDebuggerUrl:'ws://127.0.0.1:43210/devtools/browser/test-browser'})));
    let signedIn=false;const bounds:unknown[]=[];
    const page={url:()=> 'https://web.whatsapp.com/',isClosed:()=>false,evaluate:vi.fn(async fn=>String(fn).includes('querySelector')?signedIn:undefined),createCDPSession:async()=>({send:async(method:string,args:unknown)=>{if(method==='Browser.setWindowBounds')bounds.push(args);return {windowId:7};},detach:async()=>{}}),bringToFront:vi.fn(),reload:vi.fn()};
    const browser={connected:true,pages:async()=>[page],newPage:vi.fn(),once:vi.fn(),disconnect:vi.fn(async()=>{}),close:vi.fn()};nativeMocks.connect.mockResolvedValue(browser);
    const sender=await db.sender.create({data:{organizationId:'legacy',id,name:'WhatsApp',provider:'WEB'}});const provider=new NativeWhatsAppProvider(sender);await provider.connect();
    expect(nativeMocks.instances).toHaveLength(0);expect((await db.sender.findUniqueOrThrow({where:{id}})).status).toBe('WAITING_LOGIN');expect(await provider.getQRCode()).toBeNull();
    signedIn=true;
    await vi.waitFor(async()=>expect((await db.sender.findUniqueOrThrow({where:{id}})).status).toBe('CONNECTED'),{timeout:5000});
    expect(nativeMocks.instances).toHaveLength(1);expect(nativeMocks.instances[0].pupPage).toBe(page);expect(nativeMocks.instances[0].initialize).not.toHaveBeenCalled();expect(browser.newPage).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(bounds).toContainEqual({windowId:7,bounds:{windowState:'minimized'}}));
    await db.sender.update({where:{id},data:{status:'CONNECTING'}});await provider.connect();expect(nativeMocks.instances).toHaveLength(1);expect((await db.sender.findUniqueOrThrow({where:{id}})).status).toBe('CONNECTED');
    await detachNativeWhatsApp();expect(browser.disconnect).toHaveBeenCalled();expect(browser.close).not.toHaveBeenCalled();expect((await db.sender.findUniqueOrThrow({where:{id}})).status).toBe('CONNECTED');
  });
  it('rejects endpoints that do not belong to the dedicated local browser profile',async()=>{
    const profile=nativeProfilePath(`native-test-${process.pid}`);await mkdir(profile,{recursive:true});await writeFile(path.join(profile,'DevToolsActivePort'),'43210\n/devtools/browser/test-browser');
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({webSocketDebuggerUrl:'ws://example.com:43210/devtools/browser/test-browser'})));expect(await nativeBrowserEndpoint(profile)).toBeNull();
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({webSocketDebuggerUrl:'ws://127.0.0.1:43210/devtools/browser/another-browser'})));expect(await nativeBrowserEndpoint(profile)).toBeNull();
    expect(()=>nativeProfilePath('../other-profile')).toThrow();
  });
});
describe('authentication and validation',()=>{
  it('recognizes a Google Sheets link and detects common lead columns',()=>{
    expect(spreadsheetIdentity('https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz/edit#gid=123')).toEqual({id:'abcdefghijklmnopqrstuvwxyz',gid:123});
    expect(()=>spreadsheetIdentity('https://example.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz')).toThrow();
    expect(detectColumns(['Full Name','Phone Number','Project Name'])).toEqual({customerName:'Full Name',mobile:'Phone Number',project:'Project Name'});
  });
  it('hashes passwords with independent salts and rejects wrong passwords',()=>{const a=passwordHash('secure-secret'),b=passwordHash('secure-secret');expect(a).not.toBe(b);expect(verifyPassword('secure-secret',a)).toBe(true);expect(verifyPassword('wrong',a)).toBe(false);});
  it('encrypts credentials and rejects modified ciphertext',()=>{const encrypted=encrypt('private-session');expect(encrypted).not.toContain('private-session');expect(decrypt(encrypted)).toBe('private-session');expect(()=>decrypt(encrypted.slice(0,-3)+'xyz')).toThrow();});
  it('validates signed feedback tokens',()=>{const token=signedFeedbackToken();expect(verifyFeedbackSignature(token)).toBe(true);expect(verifyFeedbackSignature(token.slice(0,-1)+'!')).toBe(false);});
  it('rejects cross-origin mutations and accepts explicit loopback aliases',()=>{expect(()=>checkOrigin(new Request('http://localhost:3000/api/leads',{method:'POST',headers:{origin:'https://attacker.invalid'}}))).toThrow();expect(()=>checkOrigin(new Request('http://0.0.0.0:3000/api/leads',{method:'POST',headers:{origin:'http://127.0.0.1:3000'}}))).not.toThrow();});
  it('accepts the configured feedback origin without authorizing it for administrator requests',()=>{
    const feedbackOrigin='http://smartlead.example.com:3000';
    const request=(origin:string,site='same-origin')=>new Request(`${feedbackOrigin}/api/feedback/test`,{method:'POST',headers:{origin,'sec-fetch-site':site}});
    expect(()=>checkOrigin(request(feedbackOrigin),feedbackOrigin)).not.toThrow();
    expect(()=>checkOrigin(request(feedbackOrigin))).toThrow();
    expect(()=>checkOrigin(request('http://attacker.example:3000'),feedbackOrigin)).toThrow();
    expect(()=>checkOrigin(request('http://smartlead.example.com:4000'),feedbackOrigin)).toThrow();
    expect(()=>checkOrigin(request(feedbackOrigin,'cross-site'),feedbackOrigin)).toThrow();
  });
  it('requires feedback and a concurrency version',()=>{expect(feedbackSchema.safeParse({status:'Interested',remarks:'',version:0}).success).toBe(false);expect(feedbackSchema.safeParse({status:'Interested',remarks:'Called customer'}).success).toBe(false);});
  it('neutralizes formula injection on export',()=>{expect(safeCell('=CMD()')).toBe("'=CMD()");expect(safeCell('Ordinary value')).toBe('Ordinary value');});
});
describe('distribution strategies',()=>{
  const candidates=[0,1,2].map(i=>({id:`e${i}`,active:true,weight:[50,30,20][i],daily:0,pending:0,dailyLimit:10,capacity:100}));
  it('rotates round robin deterministically',()=>{let cursor=0;const owners=[];for(let i=0;i<4;i++){const result=chooseRecipients('ROUND_ROBIN',candidates,cursor)!;owners.push(result.owner);cursor=result.cursor;}expect(owners).toEqual(['e0','e1','e2','e0']);});
  it('allocates weighted cycles exactly 50 / 30 / 20',()=>{const counts:Record<string,number>={};for(let i=0;i<100;i++){const id=chooseRecipients('WEIGHTED',candidates,i)!.owner;counts[id]=(counts[id]||0)+1;}expect(counts).toEqual({e0:50,e1:30,e2:20});});
  it('skips inactive recipients and exhausted capacity',()=>{expect(chooseRecipients('ROUND_ROBIN',candidates.map((c,i)=>({...c,active:i!==0,pending:i===1?100:0})),0)?.owner).toBe('e2');});
  it('balances pending capacity and keeps one owner in all mode',()=>{expect(chooseRecipients('CAPACITY',candidates.map((c,i)=>({...c,pending:[90,20,40][i]})),0)?.owner).toBe('e1');expect(chooseRecipients('ALL',candidates,0)).toMatchObject({owner:'e0',notify:['e0','e1','e2']});});
  it('rejects invalid weights and single-recipient rules',()=>{const base={enabled:true,senderId:null,template:DEFAULT_TEMPLATE,recipients:[{employeeId:'e0',weight:50}]};expect(ruleSchema.safeParse({...base,mode:'WEIGHTED'}).success).toBe(false);expect(ruleSchema.safeParse({...base,mode:'SINGLE'}).success).toBe(true);});
});
describe('durable end-to-end workflow',()=>{
  it('shows sheet-write failures independently of successful imports and clears the warning once saved',async()=>{
    const {admin}=await fixture();await synchronizeSheet('sheet');
    await db.sheet.update({where:{id:'sheet'},data:{connectionType:'SIMPLE_PUBLIC'}});
    const leads=await db.lead.findMany({orderBy:{sourceRow:'asc'}});
    await db.lead.updateMany({where:{id:{in:leads.map(l=>l.id)}},data:{writebackStatus:'SYNCED'}});
    await db.lead.update({where:{id:leads[0].id},data:{writebackStatus:'ERROR'}});
    await db.lead.update({where:{id:leads[1].id},data:{writebackStatus:'PENDING'}});
    await db.syncLog.create({data:{sheetId:'sheet',operation:'WRITEBACK',status:'ERROR',details:'Google Sheet is read-only. Set link access to Editor.'}});
    const state=await simpleAction(['state'],'GET',new Request('http://localhost:3000'),admin);
    expect(state).toMatchObject({sheets:[{lastSyncError:null,writeback:{pending:1,failed:1,error:'Google Sheet is read-only. Set link access to Editor.'}}]});
    await db.lead.updateMany({data:{writebackStatus:'SYNCED'}});
    const saved=await simpleAction(['state'],'GET',new Request('http://localhost:3000'),admin);
    expect(saved).toMatchObject({sheets:[{writeback:{pending:0,failed:0,error:null}}]});
  });
  it('handles connection controls before older lead jobs',async()=>{
    const {sender}=await fixture();await db.sender.update({where:{id:sender.id},data:{status:'DISCONNECTED'}});await synchronizeSheet('sheet');
    const control=await enqueue(db,'CONNECT',sender.id,'priority-connect');await db.job.update({where:{id:control.id},data:{runAt:new Date(0)}});await drainJobs(1);
    expect(await db.job.findUniqueOrThrow({where:{id:control.id}})).toMatchObject({status:'COMPLETED',error:null});
    expect((await db.sender.findUniqueOrThrow({where:{id:sender.id}})).status).toBe('CONNECTED');expect(await db.assignment.count()).toBe(0);
  });
  it('sends simple-sheet leads in recipient order with private feedback links',async()=>{
    await fixture();await db.sheet.update({where:{id:'sheet'},data:{connectionType:'SIMPLE_SERVICE_ACCOUNT'}});
    await db.distributionRule.update({where:{sheetId:'sheet'},data:{template:SIMPLE_TEMPLATE}});
    await db.employee.updateMany({data:{dailyLimit:1,capacity:1}});
    await synchronizeSheet('sheet',new DemoSheetsProvider());
    const leads=await db.lead.findMany({orderBy:{sourceRow:'asc'}});
    for(const lead of leads)await assignLead(lead.id);
    const assignments=await db.assignment.findMany({include:{lead:true},orderBy:{lead:{sourceRow:'asc'}}});
    expect(assignments.map(a=>a.employeeId)).toEqual(['e0','e1','e2','e0']);
    expect(await db.feedbackToken.count()).toBe(4);expect(await db.job.count({where:{type:'WRITEBACK'}})).toBe(0);
    const messages=await db.message.findMany();expect(messages).toHaveLength(4);
    for(const m of messages){expect(decrypt(m.encryptedBody)).toContain('You got a new lead from Test source');expect(decrypt(m.encryptedBody)).toContain('/feedback/');await dispatchMessage(m.id);}
    expect(await db.message.count({where:{status:'SUBMITTED'}})).toBe(4);expect(await db.job.count({where:{type:'WRITEBACK'}})).toBe(4);
    await synchronizeSheet('sheet',new DemoSheetsProvider());expect(await db.lead.count()).toBe(4);expect(await db.message.count()).toBe(4);
  });
  it('holds remote sends until a live public feedback address is available',async()=>{
    await fixture();await db.sheet.update({where:{id:'sheet'},data:{connectionType:'SIMPLE_SERVICE_ACCOUNT'}});
    await synchronizeSheet('sheet',new DemoSheetsProvider());const lead=await db.lead.findFirstOrThrow();await assignLead(lead.id);
    const message=await db.message.findFirstOrThrow();await db.setting.update({where:{key:'feedback:remoteRequired'},data:{value:true}});
    const provider={sendMessage:vi.fn(async()=>({id:'public-test-send',status:'SUBMITTED'}))} as any;
    await expect(dispatchMessage(message.id,provider)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});expect(provider.sendMessage).not.toHaveBeenCalled();
    expect(await db.message.findUniqueOrThrow({where:{id:message.id}})).toMatchObject({status:'QUEUED',attemptCount:0});
    await db.setting.create({data:{key:'feedback:public',value:{url:'https://feedback.example',at:Date.now()-60000}}});
    await expect(dispatchMessage(message.id,provider)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});expect(provider.sendMessage).not.toHaveBeenCalled();
    await db.setting.update({where:{key:'feedback:public'},data:{value:{url:'https://feedback.example',at:Date.now()}}});await dispatchMessage(message.id,provider);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);expect(provider.sendMessage.mock.calls[0][0].body).toContain('https://feedback.example/feedback/');
    const admin=await db.user.findUniqueOrThrow({where:{id:'admin'}});expect(await simpleAction(['state'],'GET',new Request('http://localhost:3000'),admin)).toMatchObject({feedbackError:null});
  });
  it('includes source questions and saves status, employee and feedback for the same public lead',async()=>{
    await fixture();await db.sheet.update({where:{id:'sheet'},data:{connectionType:'SIMPLE_PUBLIC',spreadsheetId:'public-test-spreadsheet-123456789',managedColumnsApproved:false,columnMapping:{customerName:'full_name',mobile:'phone_number'}}});
    let csv='what_is_your_primary_purpose_for_buying_a_plot?,what_is_your_approximate_budget?,when_are_you_planning_to_purchase?,when_would_you_be_available_for_a_site_visit?,full_name,phone_number,city\nInvestment,50 lakh,Next month,Sunday,Sample customer,9876543210,Noida';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(csv,{headers:{'content-type':'text/csv'}})));
    await synchronizeSheet('sheet');const lead=await db.lead.findFirstOrThrow();await assignLead(lead.id);
    const outgoing=await db.message.findFirstOrThrow();let body=decrypt(outgoing.encryptedBody);
    expect(body).toContain('Hello\n\nYou got a new lead from Test source\n\nHere\'s what we know:');
    expect(body).toContain('Q.1 - What is your primary purpose for buying a plot?\nAns.- Investment');
    expect(body).toContain('Q.4 - When would you be available for a site visit?\nAns.- Sunday');
    expect(body).toContain('Name: Sample customer\nPhone: +919876543210\nCity: Noida');expect(body.endsWith('Thank you!')).toBe(true);
    expect(body).toMatch(/\*Submit Feedback\*\nhttps?:\/\/[^\s]+\/feedback\/[^\s]+\n\nThank you!/);
    const token=body.match(/\/feedback\/([^\s]+)/)![1];const access=await getFeedbackAccess(token);expect(access.assignment.lead.id).toBe(lead.id);
    csv=csv.replace('Investment,50 lakh','Home,50 lakh');await synchronizeSheet('sheet');
    body=decrypt((await db.message.findUniqueOrThrow({where:{id:outgoing.id}})).encryptedBody);expect(body).toContain('Ans.- Home');expect(body).toContain(token);expect(await db.message.count()).toBe(1);
    await saveFeedback(access.assignmentId,{status:'Interested',remarks:'Please arrange a site visit',version:access.assignment.lead.version},undefined,access.id);
    const write=vi.fn(async()=>{});await writebackLead(lead.id,{read:vi.fn(),write});
    expect(write).toHaveBeenCalledWith(expect.objectContaining({id:'sheet'}),lead.stableSourceId,null,{sentStatus:'',sharedTo:'',status:'Interested',feedback:'Please arrange a site visit'});
    expect((await db.lead.findUniqueOrThrow({where:{id:lead.id}})).writebackStatus).toBe('SYNCED');
  });
  it('starts a sheet with selected contacts and a new number, then pauses queued sends',async()=>{
    const {admin}=await fixture();await db.sheet.update({where:{id:'sheet'},data:{connectionType:'SIMPLE_SERVICE_ACCOUNT'}});
    await db.sender.create({data:{organizationId:'legacy',id:'web',name:'WhatsApp',provider:'WEB',status:'CONNECTED'}});
    const selected=[{name:'Selected contact',phone:'+919876543210'},{name:'New conversation',phone:'+919876543219'}];
    await simpleAction(['sheets','sheet','recipients'],'PUT',new Request('http://localhost:3000/api/simple/sheets/sheet/recipients',{method:'PUT',body:JSON.stringify({recipients:selected})}),admin);
    const rule=await db.distributionRule.findUniqueOrThrow({where:{sheetId:'sheet'},include:{recipients:{orderBy:{position:'asc'},include:{employee:true}}}});
    expect(rule.enabled).toBe(true);expect(rule.senderId).toBe('web');expect(rule.recipients.map(r=>r.employee.phone)).toEqual(selected.map(p=>p.phone));
    await synchronizeSheet('sheet',new DemoSheetsProvider());const lead=await db.lead.findFirstOrThrow();await assignLead(lead.id);
    await simpleAction(['sheets','sheet','pause'],'PUT',new Request('http://localhost:3000',{method:'PUT',body:JSON.stringify({enabled:false})}),admin);
    const pending=await db.message.findFirstOrThrow();const mock=new DemoWhatsAppProvider(await db.sender.findUniqueOrThrow({where:{id:'sender'}}));const send=vi.spyOn(mock,'sendMessage');
    await expect(dispatchMessage(pending.id,mock)).rejects.toThrow(/paused/);expect(send).not.toHaveBeenCalled();expect((await db.message.findUniqueOrThrow({where:{id:pending.id}})).status).toBe('QUEUED');
    const state=await simpleAction(['state'],'GET',new Request('http://localhost:3000'),admin) as any;expect(state.sheets).toHaveLength(1);expect(state.account.id).toBe('web');
    await simpleAction(['sheets','sheet','recipients'],'PUT',new Request('http://localhost:3000',{method:'PUT',body:JSON.stringify({recipients:[selected[1]]})}),admin);
    expect((await db.message.findUniqueOrThrow({where:{id:pending.id}})).status).toBe('CANCELLED');
    await assignLead(lead.id);const replacement=await db.message.findFirstOrThrow({where:{leadId:lead.id,status:'QUEUED'}});expect(replacement.recipient).toBe(selected[1].phone);
    expect(await db.assignment.count({where:{leadId:lead.id,active:true,isPrimary:true}})).toBe(1);
  });
  it('rebalances unsent leads when recipients change and preserves rotation on an unchanged save',async()=>{
    const {admin,sender,rows}=await fixture();
    rows.push({stableId:'source-4',row:6,values:{customerName:'Fifth customer',mobile:'+919800000004'}});
    await db.setting.update({where:{key:'demo-source:sheet'},data:{value:JSON.parse(JSON.stringify(rows))}});
    await db.sheet.update({where:{id:'sheet'},data:{connectionType:'SIMPLE_SERVICE_ACCOUNT'}});
    await db.sender.create({data:{organizationId:'legacy',id:'web',name:'WhatsApp',provider:'WEB',status:'CONNECTED'}});
    const people=[0,1,2].map(i=>({name:`Employee ${i}`,phone:`+91987654321${i}`}));
    const select=(recipients:typeof people)=>simpleAction(['sheets','sheet','recipients'],'PUT',new Request('http://localhost:3000',{method:'PUT',body:JSON.stringify({recipients})}),admin);
    await select([people[0]]);await synchronizeSheet('sheet',new DemoSheetsProvider());
    const leads=await db.lead.findMany({orderBy:{sourceRow:'asc'}});
    for(const lead of leads)await assignLead(lead.id);
    const submitted=await db.message.findFirstOrThrow({where:{leadId:leads[0].id}});
    await dispatchMessage(submitted.id,new DemoWhatsAppProvider(sender));
    await select(people);
    for(const lead of leads)await assignLead(lead.id);
    const queued=await db.message.findMany({where:{status:'QUEUED'},orderBy:{lead:{sourceRow:'asc'}}});
    expect(queued.map(m=>m.recipient)).toEqual([people[0].phone,people[1].phone,people[2].phone,people[0].phone]);
    expect(await db.message.count({where:{status:'SUBMITTED'}})).toBe(1);
    expect(await db.message.count({where:{status:'CANCELLED'}})).toBe(4);
    const before=await db.distributionRule.findUniqueOrThrow({where:{sheetId:'sheet'}});
    await select(people);
    expect((await db.distributionRule.findUniqueOrThrow({where:{sheetId:'sheet'}})).cursor).toBe(before.cursor);
    expect(await db.message.count({where:{status:'QUEUED'}})).toBe(4);
  });
  it('reads renamed message IDs and never submits an unidentified send twice',async()=>{
    const {sender}=await fixture();
    const client:any={getState:vi.fn(async()=> 'CONNECTED'),pupPage:{evaluate:vi.fn()},getNumberId:vi.fn(async()=>({_serialized:'test@c.us'})),sendMessage:vi.fn(async()=>({id:{$1:'renamed-id'}}))};
    registerWebClient(sender.id,client);
    try{
      const provider=new WebWhatsAppProvider(sender);
      expect(await provider.sendMessage({to:'+919876543219',body:'Mock lead',parameters:[]})).toEqual({id:'renamed-id',status:'SUBMITTED'});
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      client.sendMessage.mockResolvedValue(undefined);
      await expect(provider.sendMessage({to:'+919876543219',body:'Another mock lead',parameters:[]})).rejects.toBeInstanceOf(UncertainDelivery);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
    }finally{registerWebClient(sender.id,null);}
  });
  it('repairs only exact unambiguous existing sends without sending any messages',async()=>{
    const {admin,sender}=await fixture();await db.sheet.update({where:{id:'sheet'},data:{connectionType:'SIMPLE_SERVICE_ACCOUNT'}});
    await synchronizeSheet('sheet',new DemoSheetsProvider());
    const leads=await db.lead.findMany({orderBy:{sourceRow:'asc'}});
    for(const lead of leads.slice(0,2))await assignLead(lead.id);
    const messages=await db.message.findMany({orderBy:{lead:{sourceRow:'asc'}}});
    const attemptedAt=new Date(Math.floor(Date.now()/1000)*1000);
    await db.message.updateMany({data:{status:'FAILED',uncertain:true,attemptCount:1,lastAttemptAt:attemptedAt,failedAt:attemptedAt,failureReason:'Acceptance is uncertain.'}});
    const existing=[{id:{fromMe:true,$1:'existing-id'},body:decrypt(messages[0].encryptedBody),t:attemptedAt.getTime()/1000},...[1,2].map(i=>({id:{fromMe:true,$1:`ambiguous-${i}`},body:decrypt(messages[1].encryptedBody),t:attemptedAt.getTime()/1000}))];
    const history=vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce([]).mockResolvedValueOnce(existing).mockResolvedValue([]);
    vi.stubGlobal('window',{WWebJS:{getChat:vi.fn(async()=>({msgs:{getModelsArray:()=>[]}}))},require:()=>({loadEarlierMsgs:history})});
    const client:any={getState:vi.fn(async()=> 'CONNECTED'),sendMessage:vi.fn(),pupPage:{evaluate:vi.fn(async(fn,input)=>fn(input))}};
    registerWebClient(sender.id,client);
    try{
      await new WebWhatsAppProvider(sender).reconcileMessages();
      expect(await db.message.findUniqueOrThrow({where:{id:messages[0].id}})).toMatchObject({status:'SUBMITTED',uncertain:false,providerMessageId:'existing-id',attemptCount:1});
      expect(await db.message.findUniqueOrThrow({where:{id:messages[1].id}})).toMatchObject({status:'FAILED',uncertain:true,providerMessageId:null});
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(history).toHaveBeenCalled();
      const state=await simpleAction(['state'],'GET',new Request('http://localhost:3000'),admin) as any;
      expect(state.sheets[0].delivery).toMatchObject({submitted:1,failed:1,error:'Acceptance is uncertain.'});
    }finally{registerWebClient(sender.id,null);}
  });
  it('imports initially, detects new rows, and prevents duplicates',async()=>{const f=await fixture();expect((await synchronizeSheet('sheet')).imported).toBe(4);expect((await synchronizeSheet('sheet')).imported).toBe(0);f.rows.push({stableId:'source-new',row:9,values:{customerName:'New customer',mobile:'+919800000099'}});await db.setting.update({where:{key:'demo-source:sheet'},data:{value:JSON.parse(JSON.stringify(f.rows))}});expect((await synchronizeSheet('sheet')).imported).toBe(1);expect(await db.lead.count()).toBe(5);});
  it('assigns once, sends once, and generates an authorized feedback link',async()=>{await fixture();await synchronizeSheet('sheet');await drainJobs(100);const lead=await db.lead.findFirstOrThrow({include:{assignments:true,messages:true}});expect(lead.assignments).toHaveLength(1);expect(lead.messages[0].status).toBe('SUBMITTED');await assignLead(lead.id);await dispatchMessage(lead.messages[0].id);expect(await db.assignment.count({where:{leadId:lead.id}})).toBe(1);expect((await db.message.findUniqueOrThrow({where:{id:lead.messages[0].id}})).attemptCount).toBe(1);const token=decrypt(lead.messages[0].encryptedBody).match(/\/feedback\/([^\s]+)/)![1];expect((await getFeedbackAccess(token)).assignment.leadId).toBe(lead.id);});
  it('keeps disconnected sends queued and resumes after reconnection',async()=>{const {sender}=await fixture();await db.sender.update({where:{id:sender.id},data:{status:'DISCONNECTED'}});await synchronizeSheet('sheet');await drainJobs(100);expect(await db.message.count({where:{status:'QUEUED'}})).toBe(4);await new DemoWhatsAppProvider(sender).connect();await db.job.updateMany({where:{type:'SEND',status:'PENDING'},data:{runAt:new Date()}});await drainJobs(100);expect(await db.message.count({where:{status:'SUBMITTED'}})).toBe(4);});
  it('stores feedback repeatedly without creating duplicate leads',async()=>{await fixture();await synchronizeSheet('sheet');await drainJobs(100);const a=await db.assignment.findFirstOrThrow({where:{isPrimary:true},include:{lead:true}});await saveFeedback(a.id,{status:'Interested',remarks:'Customer likes the project',version:a.lead.version});const updated=await db.lead.findUniqueOrThrow({where:{id:a.leadId}});await saveFeedback(a.id,{status:'Site Visit Scheduled',remarks:'Visit scheduled for Sunday',version:updated.version});await drainJobs(100);expect(await db.feedback.count({where:{leadId:a.leadId}})).toBe(2);expect(await db.lead.count()).toBe(4);const source=await new DemoSheetsProvider().read(await db.sheet.findUniqueOrThrow({where:{id:'sheet'}}));expect(source.find(r=>r.stableId===a.lead.stableSourceId)?.values.status).toBe('Site Visit Scheduled');});
  it('rejects simultaneous stale feedback and preserves the accepted history',async()=>{await fixture();await synchronizeSheet('sheet');await drainJobs(100);const a=await db.assignment.findFirstOrThrow({where:{isPrimary:true},include:{lead:true}});const data={status:'Interested',remarks:'Customer called back',version:a.lead.version};const result=await Promise.allSettled([saveFeedback(a.id,data),saveFeedback(a.id,data)]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.feedback.count()).toBe(1);});
  it('reassigns manually and revokes the former owner’s feedback link',async()=>{await fixture('MANUAL');await synchronizeSheet('sheet');const lead=await db.lead.findFirstOrThrow();await assignLead(lead.id,'e0','admin');const message=await db.message.findFirstOrThrow();const token=decrypt(message.encryptedBody).match(/\/feedback\/([^\s]+)/)![1];await assignLead(lead.id,'e1','admin',true);await expect(getFeedbackAccess(token)).rejects.toThrow(/expired|revoked/);expect(await db.assignment.count({where:{leadId:lead.id,isPrimary:true,active:true}})).toBe(1);});
  it('does not inflate unique leads when notifying everyone',async()=>{const {admin}=await fixture('ALL');await synchronizeSheet('sheet');await drainJobs(100);const data=await workspace(admin,new URLSearchParams());expect(data.stats.total).toBe(4);expect(data.stats.assigned).toBe(4);expect(data.stats.notifications).toBe(12);expect(await db.feedbackToken.count()).toBe(4);});
  it('restricts executive and manager access to their assigned records',async()=>{await fixture();await synchronizeSheet('sheet');await drainJobs(100);const executive=await db.user.findUniqueOrThrow({where:{id:'u1'}});expect(await db.lead.count({where:leadScope(executive)})).toBe(1);const manager=await db.user.create({data:{organizationId:'legacy',name:'Manager',email:'manager@test.invalid',passwordHash:'unused',role:'MANAGER'}});expect(await db.lead.count({where:leadScope(manager)})).toBe(0);await db.sheetAccess.create({data:{userId:manager.id,sheetId:'sheet'}});expect(await db.lead.count({where:leadScope(manager)})).toBe(4);});
  it('updates a moved row by stable identity and refuses a deleted row',async()=>{await fixture();await synchronizeSheet('sheet');await drainJobs(100);const lead=await db.lead.findFirstOrThrow();const provider=new DemoSheetsProvider();const sheet=await db.sheet.findUniqueOrThrow({where:{id:'sheet'}});let rows=(await provider.read(sheet)).reverse().map((r,i)=>({...r,row:i+2}));await db.setting.update({where:{key:'demo-source:sheet'},data:{value:JSON.parse(JSON.stringify(rows))}});await synchronizeSheet('sheet');await writebackLead(lead.id);rows=rows.filter(r=>r.stableId!==lead.stableSourceId);await db.setting.update({where:{key:'demo-source:sheet'},data:{value:JSON.parse(JSON.stringify(rows))}});await expect(writebackLead(lead.id)).rejects.toThrow(/deleted/);});
  it('preserves feedback when Google is unavailable and retries writeback independently',async()=>{await fixture();await synchronizeSheet('sheet');await drainJobs(100);const a=await db.assignment.findFirstOrThrow({where:{isPrimary:true},include:{lead:true}});await saveFeedback(a.id,{status:'Interested',remarks:'Feedback survives outage',version:a.lead.version});await expect(writebackLead(a.leadId,{read:vi.fn(),write:vi.fn().mockRejectedValue(new AppError(502,'Google unavailable'))})).rejects.toThrow();expect((await db.lead.findUniqueOrThrow({where:{id:a.leadId}})).lastFeedback).toBe('Feedback survives outage');await writebackLead(a.leadId);expect((await db.lead.findUniqueOrThrow({where:{id:a.leadId}})).writebackStatus).toBe('SYNCED');});
  it('holds uncertain provider timeouts without automatic resend',async()=>{await fixture();await synchronizeSheet('sheet');const lead=await db.lead.findFirstOrThrow();await assignLead(lead.id);const m=await db.message.findFirstOrThrow();const provider=new DemoWhatsAppProvider(await db.sender.findUniqueOrThrow({where:{id:'sender'}}));vi.spyOn(provider,'sendMessage').mockRejectedValue(new UncertainDelivery('timeout'));await dispatchMessage(m.id,provider);const failed=await db.message.findUniqueOrThrow({where:{id:m.id}});expect(failed.status).toBe('FAILED');expect(failed.uncertain).toBe(true);await dispatchMessage(m.id,provider);expect(provider.sendMessage).toHaveBeenCalledTimes(1);});
  it('detects external changes to managed cells instead of overwriting feedback',async()=>{await fixture();await synchronizeSheet('sheet');await drainJobs(100);const lead=await db.lead.findFirstOrThrow();const source=await new DemoSheetsProvider().read(await db.sheet.findUniqueOrThrow({where:{id:'sheet'}}));source.find(r=>r.stableId===lead.stableSourceId)!.values.feedback='Changed manually in Google';await db.setting.update({where:{key:'demo-source:sheet'},data:{value:JSON.parse(JSON.stringify(source))}});await expect(writebackLead(lead.id)).rejects.toThrow(/changed outside/);});
  it('uses metadata filters and skips unrelated Google cells',async()=>{await fixture();await synchronizeSheet('sheet');const lead=await db.lead.findFirstOrThrow();const sheet=await db.sheet.findUniqueOrThrow({where:{id:'sheet'}});const headers=['ID','Name','Phone',...Object.values(MANAGED)];const source=[lead.stableSourceId,lead.customerName,lead.mobile];const requests:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init:any)=>{requests.push({url,body:init?.body?JSON.parse(init.body):null});if(url.includes('batchGetByDataFilter'))return Response.json({valueRanges:[{valueRange:{values:[source]}}]});if(url.includes('batchUpdateByDataFilter'))return Response.json({totalUpdatedRows:1});return Response.json({values:[headers]});}));await new GoogleSheetsProvider().write(sheet,lead.stableSourceId,lead.metadataId,{status:'Interested'});const write=requests.find(r=>r.url.includes('batchUpdateByDataFilter'));expect(write.body.data[0].dataFilter.developerMetadataLookup.metadataId).toBe(lead.metadataId);expect(write.body.data[0].values[0].slice(0,3)).toEqual([null,null,null]);expect(write.body.valueInputOption).toBe('RAW');});
});
