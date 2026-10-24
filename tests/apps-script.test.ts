import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createContext,runInContext} from 'node:vm';
import {db} from '@/lib/db';
import {AppsScriptSheetsProvider,appsScriptEndpoint,appsScriptRequest,checkAppsScriptSetup,connectAppsScriptSheet,startAppsScriptSetup} from '@/lib/apps-script';
import {decrypt,encrypt,passwordHash} from '@/lib/security';
import {assignLead,saveFeedback,synchronizeSheet,updateLeadSheetNow,writebackLead} from '@/lib/engine';
import {simpleAction} from '@/lib/simple';
import {clearTestModels} from './database-fixture';
import {simpleSourceRows} from '@/lib/public-sheets';

const endpoint='https://script.google.com/macros/s/AKfycb_test_deployment_123456789/exec';
const spreadsheetId='script-source-test-123456789';
const mapping={leadId:'ID',customerName:'Name',mobile:'Phone'};
beforeEach(async()=>{
  vi.stubEnv('GOOGLE_CLIENT_ID','');vi.stubEnv('GOOGLE_CLIENT_SECRET','');
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Test organisation'},update:{}});
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});afterAll(()=>db.$disconnect());

async function fixture(){
  const user=await db.user.create({data:{organizationId:'legacy',name:'Owner',email:'script@test.invalid',role:'SUPER_ADMIN',passwordHash:passwordHash('TestPassword123!')}});
  const setup=await startAppsScriptSetup(user,{url:`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=42`});
  const rows=[['ID','Name','Phone','What is your budget?','lead_status'],['a','Customer A','9876543210','Keep A','New'],['b','Customer B','9876543211','Keep B','New']];
  const tags:any[]=[];const writes:string[]=[];let maxColumns=26;
  const controls={metadata:true,editable:true,saveError:false};
  function finder(){let key:string|undefined,value:string|undefined;return {withKey(k:string){key=k;return this;},withValue(v:string){value=v;return this;},find(){return tags.filter(t=>(!key||t.key===key)&&(!value||t.value===value));}};}
  function addTag(key:string,value:string,row?:string[]){const tag={key,value,row,getLocation:()=>({getRow:()=>row?{getRow:()=>rows.indexOf(row)+1}:null}),remove:()=>{tags.splice(tags.indexOf(tag),1);}};tags.push(tag);return tag;}
  const tab={getSheetId:()=>42,getName:()=> 'Incoming',getLastColumn:()=>Math.max(...rows.map(r=>r.length)),getMaxRows:()=>100,getMaxColumns:()=>maxColumns,
    getDataRange:()=>({getDisplayValues:()=>rows.map(r=>Array.from({length:tab.getLastColumn()},(_,i)=>r[i]||''))}),createDeveloperMetadataFinder:finder,
    insertColumnsAfter:(_index:number,count:number)=>{maxColumns+=count;},
    moveColumns:(range:any,destination:number)=>{const from=range.column-1;for(const row of rows){while(row.length<tab.getLastColumn())row.push('');const moved=row.splice(from,1);row.splice(destination-1-(destination>range.column?1:0),0,...moved);}},
    getRange:(row:number|string,column?:number,height=1,width=1)=>{const r=typeof row==='string'?Number(row.split(':')[0]):row;const c=column||1;return {column:c,getRow:()=>r,canEdit:()=>controls.editable,
      getDisplayValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>rows[r-1+i]?.[c-1+j]||'')),
      setValue:(value:string)=>{rows[r-1][c-1]=value;writes.push('value');},
      setValues:(values:string[][])=>{for(let i=0;i<values.length;i++)values[i].forEach((v,j)=>{rows[r-1+i][c-1+j]=v;});},
      setRichTextValue:(value:{text:string})=>{if(controls.saveError)throw new Error('Sensitive source values must not escape');rows[r-1][c-1]=value.text;writes.push('rich');},clearContent:()=>{rows[r-1][c-1]='';},
      addDeveloperMetadata:(key:string,value:string)=>{if(!controls.metadata)throw new Error('Row metadata is not supported');return addTag(key,value,rows[r-1]);},
    };},
  };
  const book={getId:()=>spreadsheetId,getName:()=> 'Private script leads',getSheets:()=>[tab],addDeveloperMetadata:(key:string,value:string)=>addTag(key,value),createDeveloperMetadataFinder:finder};
  const context=createContext({SpreadsheetApp:{openById:(id:string)=>{expect(id).toBe(spreadsheetId);return book;},DeveloperMetadataVisibility:{DOCUMENT:'DOCUMENT'},flush:()=>{},newRichTextValue:()=>({text:'',setText(text:string){this.text=text;return this;},build(){return {text:this.text};}})},LockService:{getScriptLock:()=>({tryLock:()=>true,hasLock:()=>true,releaseLock:()=>{}})},Utilities:{getUuid:()=>String(Math.random())},ContentService:{MimeType:{JSON:'json'},createTextOutput:(text:string)=>({text,setMimeType(){return this;}})}});
  runInContext(setup.code,context);
  const calls:Array<{url:string;body:any}>=[];
  vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
    expect(input).toBe(endpoint);const body=JSON.parse(String(init?.body));calls.push({url:input,body});
    context.INPUT=JSON.stringify(body);const reply=runInContext('doPost({postData:{contents:INPUT}})',context);return new Response(reply.text,{headers:{'content-type':'application/json'}});
  }));
  const connect=async(project?:string)=>{await checkAppsScriptSetup(user,setup.setupId,endpoint);const result=await connectAppsScriptSheet(user,{scriptSetupId:setup.setupId,spreadsheetId,worksheetId:42,columnMapping:mapping,project});return db.sheet.findUniqueOrThrow({where:{id:result.id}});};
  return {user,setup,rows,tags,writes,calls,context,connect,controls};
}

describe('Apps Script connection',()=>{
  it('stores the entered project separately from the sheet title and original source values',async()=>{
    const f=await fixture();const source=f.rows.map(row=>row.slice(0,5));const sheet=await f.connect('Corbett Meadows');
    expect(sheet.project).toBe('Corbett Meadows');expect(sheet.name).toBe('Private script leads');expect(f.rows.map(row=>row.slice(0,5))).toEqual(source);
  });
  it('generates private per-sheet code and verifies read/write access before creating a connection',async()=>{
    const f=await fixture();expect(f.setup.code).toContain(spreadsheetId);expect(await db.sheet.count()).toBe(0);
    const checked=await checkAppsScriptSetup(f.user,f.setup.setupId,endpoint);expect(checked).toMatchObject({spreadsheetId,canRead:true,canWrite:true,gid:42});expect(f.tags).toEqual([]);
    const stored=await db.setting.findUniqueOrThrow({where:{key:`apps-script:${f.setup.setupId}`}});expect(JSON.stringify(stored.value)).not.toContain(runInContext('SMARTLEAD_KEY',f.context));
    const sheet=await f.connect();expect(sheet.connectionType).toBe('SIMPLE_APPS_SCRIPT');const credential=await db.googleCredential.findUniqueOrThrow({where:{id:sheet.credentialId!}});expect(credential.type).toBe('APPS_SCRIPT');expect(credential.encryptedValue).not.toContain(endpoint);
  });
  it('runs the generated script to read private rows and save all four fields, following moved leads',async()=>{
    const f=await fixture();const sheet=await f.connect();await synchronizeSheet(sheet.id);const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id,stableSourceId:'public-id:a'}});
    const provider=new AppsScriptSheetsProvider();const values={sentStatus:'Sent',sharedTo:'Recipient',status:'Interested',feedback:'=1+1'};
    const observed=await provider.write(sheet,lead.stableSourceId,null,values);expect(observed).toMatchObject(values);
    expect(f.rows[0].slice(-4)).toEqual(['Sent Status','Shared To','Feedback','Remark']);expect(f.rows[1].slice(0,5)).toEqual(['a','Customer A','9876543210','Keep A','New']);expect(f.rows[2].slice(0,5)).toEqual(['b','Customer B','9876543211','Keep B','New']);expect(f.writes).not.toContain('value');
    await db.lead.update({where:{id:lead.id},data:{managedSnapshot:{...observed,__publicOutputV2:'1',__publicFeedbackInitialized:'1'}}});
    [f.rows[1],f.rows[2]]=[f.rows[2],f.rows[1]];await provider.write(sheet,lead.stableSourceId,null,{feedback:'Call tomorrow'});
    expect(f.rows[2].at(-1)).toBe('Call tomorrow');expect(f.rows[1].at(-1)).not.toBe('Call tomorrow');
  });
  it('preserves manual changes and rejects deleted or duplicate source identities',async()=>{
    const f=await fixture();const sheet=await f.connect();await synchronizeSheet(sheet.id);const provider=new AppsScriptSheetsProvider();const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id,stableSourceId:'public-id:a'}});
    await provider.write(sheet,lead.stableSourceId,null,{feedback:'First'});f.rows[1][f.rows[0].indexOf('Remark')]='External edit';
    await expect(provider.write(sheet,lead.stableSourceId,null,{feedback:'Replace'})).rejects.toMatchObject({code:'SYNC_CONFLICT'});expect(f.rows[1].at(-1)).toBe('External edit');
    f.rows.splice(1,1);await expect(provider.write(sheet,lead.stableSourceId,null,{feedback:'Deleted'})).rejects.toMatchObject({code:'SYNC_CONFLICT'});
  });
  it('saves immediately through the durable job and does not send WhatsApp messages',async()=>{
    const f=await fixture();const sheet=await f.connect();await synchronizeSheet(sheet.id);
    const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id,stableSourceId:'public-id:a'}});
    const employee=await db.employee.create({data:{organizationId:'legacy',name:'Owner',phone:'+919800000001',projects:[]}});
    const assignment=await db.assignment.create({data:{leadId:lead.id,employeeId:employee.id,isPrimary:true}});
    await saveFeedback(assignment.id,{status:'Interested',remarks:'Visit tomorrow',version:lead.version});
    expect(await updateLeadSheetNow(lead.id)).toEqual({status:'SYNCED',error:null});
    expect(f.rows[1].slice(-4)).toEqual(['','','Interested','Visit tomorrow']);
    expect(await db.job.count({where:{type:'WRITEBACK',status:'PENDING'}})).toBe(0);expect(await db.message.count()).toBe(0);
  });
  it('updates unique source rows even when Google rejects row metadata',async()=>{
    const f=await fixture();const sheet=await f.connect();await synchronizeSheet(sheet.id);f.controls.metadata=false;
    const provider=new AppsScriptSheetsProvider();
    await provider.write(sheet,'public-id:a',null,{sentStatus:'Sent',sharedTo:'Owner',status:'Interested',feedback:'Call tomorrow'});
    expect(f.rows[1].slice(-4)).toEqual(['Sent','Owner','Interested','Call tomorrow']);
    [f.rows[1],f.rows[2]]=[f.rows[2],f.rows[1]];
    await db.lead.update({where:{sheetId_stableSourceId:{sheetId:sheet.id,stableSourceId:'public-id:a'}},data:{managedSnapshot:{sentStatus:'Sent'}}});
    await provider.write(sheet,'public-id:a',null,{sentStatus:'Sent'});expect(f.rows[2].at(-4)).toBe('Sent');
  });
  it('reports protected output cells and the failing stage without disclosing source data',async()=>{
    const f=await fixture();const sheet=await f.connect();await synchronizeSheet(sheet.id);const provider=new AppsScriptSheetsProvider();
    f.controls.editable=false;
    await expect(provider.write(sheet,'public-id:a',null,{sentStatus:'Sent'})).rejects.toMatchObject({code:'APPS_SCRIPT_PROTECTED'});expect(f.rows[1].at(-4)).not.toBe('Sent');
    f.controls.editable=true;f.controls.saveError=true;
    await expect(provider.write(sheet,'public-id:a',null,{sentStatus:'Sent'})).rejects.toMatchObject({code:'APPS_SCRIPT_UPGRADE',message:expect.stringContaining('saving the output cells')});
    try{await provider.write(sheet,'public-id:a',null,{sentStatus:'Sent'});}catch(error:any){expect(error.message).not.toContain('Sensitive');}
  });
  it('reuses an existing connection key when generating repair code and retains its deployment URL',async()=>{
    const f=await fixture();const sheet=await f.connect();const previous=runInContext('SMARTLEAD_KEY',f.context);
    const setup=await startAppsScriptSetup(f.user,{sheetId:sheet.id});expect(setup.endpoint).toBe(endpoint);expect(setup.code).toContain(previous);expect(setup.code).toContain('SMARTLEAD_CODE_VERSION = 2');
  });
  it('checks output writes before saving a connection and preserves feedback after a failed immediate attempt',async()=>{
    const f=await fixture();f.controls.editable=false;await expect(f.connect()).rejects.toMatchObject({code:'APPS_SCRIPT_PROTECTED'});expect(await db.sheet.count()).toBe(0);
    f.controls.editable=true;const sheet=await f.connect();await synchronizeSheet(sheet.id);const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id,stableSourceId:'public-id:a'}});
    const employee=await db.employee.create({data:{organizationId:'legacy',name:'Owner',phone:'+919800000001',projects:[]}});const assignment=await db.assignment.create({data:{leadId:lead.id,employeeId:employee.id,isPrimary:true}});
    await saveFeedback(assignment.id,{status:'Interested',remarks:'Preserve this remark',version:lead.version});f.controls.saveError=true;
    expect(await updateLeadSheetNow(lead.id)).toMatchObject({status:'ERROR',error:expect.stringContaining('saving the output cells')});
    expect((await db.lead.findUniqueOrThrow({where:{id:lead.id}})).lastFeedback).toBe('Preserve this remark');expect(await db.job.count({where:{type:'WRITEBACK',status:'PENDING'}})).toBe(1);expect(await db.message.count()).toBe(0);
  });
  it('retries sheet updates in the requesting organisation and leaves sending paused',async()=>{
    const f=await fixture();const sheet=await f.connect();await synchronizeSheet(sheet.id);const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id,stableSourceId:'public-id:a'}});
    await db.lead.update({where:{id:lead.id},data:{writebackStatus:'ERROR'}});
    await db.job.create({data:{organizationId:'legacy',type:'WRITEBACK',entityId:lead.id,key:'old-failure',status:'DEAD',attempts:8}});
    const request=()=>new Request('http://localhost',{method:'POST'});
    await expect(simpleAction(['sheets',sheet.id,'writeback'],'POST',request(),{...f.user,organizationId:'other-org'})).rejects.toMatchObject({status:404});
    expect(await simpleAction(['sheets',sheet.id,'writeback'],'POST',request(),f.user)).toMatchObject({attempted:1,remaining:0,writeback:{status:'SYNCED'}});
    expect((await db.distributionRule.findUniqueOrThrow({where:{sheetId:sheet.id}})).enabled).toBe(false);expect(await db.message.count()).toBe(0);
  });
  it('reconnects an existing source without resetting recipients, cursor or successful sends',async()=>{
    const f=await fixture();const employee=await db.employee.create({data:{organizationId:'legacy',name:'Recipient',phone:'+919800000001',projects:[]}});const sender=await db.sender.create({data:{organizationId:'legacy',name:'WhatsApp',provider:'DEMO',status:'CONNECTED'}});
    const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Existing',project:'Sales',spreadsheetId,worksheetId:42,worksheetName:'Incoming',connectionType:'SIMPLE_PUBLIC',columnMapping:mapping,rule:{create:{mode:'ROUND_ROBIN',enabled:true,senderId:sender.id,template:'Lead',recipients:{create:{employeeId:employee.id,position:0}}}}}});
    await synchronizeSheet(sheet.id,{read:async()=>simpleSourceRows(sheet,f.rows),write:async()=>{}});const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id,stableSourceId:'public-id:a'}});await assignLead(lead.id);const message=await db.message.findFirstOrThrow({where:{leadId:lead.id}});await db.message.update({where:{id:message.id},data:{status:'SUBMITTED',uncertain:false}});await db.distributionRule.update({where:{sheetId:sheet.id},data:{cursor:7}});
    await db.lead.update({where:{id:lead.id},data:{status:'Interested',lastFeedback:'Arrange a visit'}});
    const sends=await db.job.count({where:{type:'SEND'}});const connected=await f.connect();expect(connected.id).toBe(sheet.id);expect(await db.sheet.count()).toBe(1);expect((await db.distributionRule.findUniqueOrThrow({where:{sheetId:sheet.id}})).cursor).toBe(7);expect(await db.ruleRecipient.count()).toBe(1);
    await synchronizeSheet(sheet.id);await writebackLead(lead.id);expect(await db.message.count()).toBe(1);expect(await db.job.count({where:{type:'SEND'}})).toBe(sends);expect(f.rows[1].slice(-4)).toEqual(['Sent','Recipient','Interested','Arrange a visit']);
  });
  it('rejects other organisations, expired setups and reuse of a consumed setup',async()=>{
    const f=await fixture();await expect(checkAppsScriptSetup({...f.user,organizationId:'another-org'},f.setup.setupId,endpoint)).rejects.toMatchObject({status:404});
    await f.connect();await expect(checkAppsScriptSetup(f.user,f.setup.setupId,endpoint)).rejects.toMatchObject({status:404});
    const expired=await startAppsScriptSetup(f.user,{url:f.setup.sheetUrl});const setting=await db.setting.findUniqueOrThrow({where:{key:`apps-script:${expired.setupId}`}});await db.setting.update({where:{key:setting.key},data:{value:{...setting.value as object,createdAt:Date.now()-86400001}}});
    await expect(checkAppsScriptSetup(f.user,expired.setupId,endpoint)).rejects.toMatchObject({status:410});
  });
  it('keeps connections uncreated when deployments require sign-in or identify another sheet',async()=>{
    const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>Sign in to Google</html>')));await expect(checkAppsScriptSetup(f.user,f.setup.setupId,endpoint)).rejects.toMatchObject({code:'APPS_SCRIPT_DEPLOYMENT'});expect(await db.sheet.count()).toBe(0);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:true,protocol:'smartlead-apps-script-v1',spreadsheetId:'other-sheet',data:{}})));await expect(checkAppsScriptSetup(f.user,f.setup.setupId,endpoint)).rejects.toMatchObject({code:'APPS_SCRIPT_SOURCE'});
  });
  it('requires the script key before returning any sheet data',async()=>{
    const f=await fixture();f.context.INPUT=JSON.stringify({action:'read',spreadsheetId,worksheetId:42,token:'wrong'});const result=JSON.parse(runInContext('doPost({postData:{contents:INPUT}})',f.context).text);expect(result).toMatchObject({ok:false,code:'AUTH'});expect(result.data).toBeUndefined();
  });
  it('restricts endpoints and never forwards the private key to a redirect',async()=>{
    for(const bad of ['http://localhost/exec','https://example.com/macros/s/123/exec',endpoint.replace('/exec','/dev'),endpoint+'?token=secret',endpoint.replace('script.google.com','script.google.com.evil.invalid')])expect(()=>appsScriptEndpoint(bad)).toThrow();
    const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?user_content_key=example'}}):Response.json({ok:true,protocol:'smartlead-apps-script-v1',spreadsheetId,data:{rows:[]}});}));
    await appsScriptRequest({endpoint,spreadsheetId,token:'private-token-'.repeat(4)},'read');expect(calls[1].options.body).toBeUndefined();expect(calls[1].options.headers).toBeUndefined();
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})));await expect(appsScriptRequest({endpoint,spreadsheetId,token:'private-token-'.repeat(4)},'read')).rejects.toMatchObject({code:'APPS_SCRIPT_DEPLOYMENT'});
  });
});
