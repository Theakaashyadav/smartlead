import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '@/lib/db';
import {AuthorizedSheetsProvider,googleToken,verifyGoogleSheetEditor} from '@/lib/google';
import {simpleSourceRows} from '@/lib/public-sheets';
import {attachAuthorizedSheet,finishGoogleAuthorization,googleAuthorizationUsesPopup,googleOAuthConfiguration,startGoogleAuthorization} from '@/lib/google-oauth';
import {assignLead,synchronizeSheet,writebackLead} from '@/lib/engine';
import {decrypt,encrypt,passwordHash} from '@/lib/security';
import {simpleAction} from '@/lib/simple';
import {clearTestModels} from './database-fixture';

const mocks=vi.hoisted(()=>({cookies:new Map<string,string>(),exchange:vi.fn(),options:vi.fn(),launch:vi.fn(),refreshed:false}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>mocks.cookies.has(key)?{value:mocks.cookies.get(key)}:undefined,set:(key:string,value:string)=>mocks.cookies.set(key,value),delete:(key:string)=>mocks.cookies.delete(key)})}));
vi.mock('puppeteer',()=>({launch:mocks.launch}));
vi.mock('google-auth-library',()=>({
  GoogleAuth:class{async getAccessToken(){return 'api-token';}},
  OAuth2Client:class{
    credentials:Record<string,any>={};
    setCredentials(value:Record<string,any>){this.credentials=value;}
    async getAccessToken(){if(mocks.refreshed)this.credentials={...this.credentials,access_token:'refreshed-token',expiry_date:9999999999999};return {token:this.credentials.access_token||'api-token'};}
    getToken=mocks.exchange;
    generateAuthUrl(options:any){mocks.options(options);const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.searchParams.set('state',options.state);return url.toString();}
  },
}));

beforeEach(async()=>{
  mocks.cookies.clear();mocks.options.mockClear();mocks.launch.mockClear();mocks.refreshed=false;
  mocks.exchange.mockReset().mockResolvedValue({tokens:{access_token:'access-token',refresh_token:'private-refresh-token',scope:'https://www.googleapis.com/auth/spreadsheets'}});
  vi.stubEnv('GOOGLE_CLIENT_ID','test-client');vi.stubEnv('GOOGLE_CLIENT_SECRET','test-secret');vi.stubEnv('GOOGLE_REDIRECT_URI','');
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Test organisation'},update:{}});
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
afterAll(()=>db.$disconnect());

async function fixture(){
  const user=await db.user.create({data:{organizationId:'legacy',name:'Owner',email:'owner@test.invalid',role:'SUPER_ADMIN',passwordHash:passwordHash('TestPassword123!')}});
  const credential=await db.googleCredential.create({data:{organizationId:'legacy',label:'Test Google',type:'SERVICE_ACCOUNT',encryptedValue:encrypt('{}')}});
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Private leads',project:'Sales',spreadsheetId:'private-sheet-test-123456789',worksheetId:42,worksheetName:'Incoming',connectionType:'SIMPLE_GOOGLE',credentialId:credential.id,columnMapping:{leadId:'ID',customerName:'Name',mobile:'Phone'}}});
  const lead=await db.lead.create({data:{sheetId:sheet.id,stableSourceId:'public-id:a',sourceRow:3,sourceFingerprint:'test',customerName:'Customer A',mobile:'+919876543210',project:'Sales',managedSnapshot:{status:'',feedback:'',sentStatus:'',sharedTo:'',__publicOutputV2:'1',__publicFeedbackInitialized:'1'}}});
  const rows=[['ID','Name','Phone','What is your budget?','lead_status'],['b','Customer B','9876543211','Keep B','New'],['a','Customer A','9876543210','Keep A','New']];
  const metadata:any[]=[];const calls:Array<{url:string;body:any}>=[];let nextId=100;let readOnly=false;
  const column=(letters:string)=>[...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
    expect(new URL(url).hostname).toBe('sheets.googleapis.com');
    expect((init?.headers as Record<string,string>).Authorization).toMatch(/^Bearer /);
    const body=init?.body?JSON.parse(String(init.body)):null;calls.push({url,body});
    if(readOnly&&body)return Response.json({error:{message:'Insufficient permissions'}},{status:403});
    if(url.includes('/values:batchGetByDataFilter')){
      const tag=metadata.find(t=>t.metadataId===body.dataFilters[0].developerMetadataLookup.metadataId);
      return Response.json({valueRanges:tag?[{valueRange:{values:[rows[tag.location.dimensionRange.startIndex]]}}]:[]});
    }
    if(url.includes('/values:batchUpdateByDataFilter')){
      const tag=metadata.find(t=>t.metadataId===body.data[0].dataFilter.developerMetadataLookup.metadataId);
      if(!tag)return Response.json({totalUpdatedRows:0});
      body.data[0].values[0].forEach((value:string|null,i:number)=>{if(value!==null)rows[tag.location.dimensionRange.startIndex][i]=value;});
      return Response.json({totalUpdatedRows:1});
    }
    if(url.endsWith('/values:batchUpdate')){
      for(const data of body.data){const match=data.range.match(/!([A-Z]+)(\d+)/)!;const start=column(match[1]);for(let r=0;r<data.values.length;r++)data.values[r].forEach((value:string,i:number)=>{rows[Number(match[2])-1+r][start+i]=value;});}
      return Response.json({totalUpdatedRows:1});
    }
    if(url.endsWith(':batchUpdate')){
      const replies=body.requests.map((request:any)=>{
        if(request.createDeveloperMetadata){const tag={...request.createDeveloperMetadata.developerMetadata,metadataId:nextId++};metadata.push(tag);return {createDeveloperMetadata:{developerMetadata:tag}};}
        if(request.deleteDeveloperMetadata){const key=request.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataKey;for(let i=metadata.length-1;i>=0;i--)if(metadata[i].metadataKey===key)metadata.splice(i,1);}
        if(request.moveDimension){const {source,destinationIndex}=request.moveDimension;for(const row of rows){while(row.length<rows[0].length)row.push('');const cells=row.splice(source.startIndex,1);row.splice(destinationIndex-(destinationIndex>source.startIndex?1:0),0,...cells);}}
        return {};
      });return Response.json({replies});
    }
    if(url.includes('/values/'))return Response.json({values:url.includes('1%3A1')?[rows[0]]:rows});
    if(url.includes('fields=developerMetadata'))return Response.json({developerMetadata:metadata});
    return Response.json({properties:{title:'Private leads'},sheets:[{properties:{sheetId:42,title:'Incoming'}}]});
  }));
  return {user,credential,sheet,lead,rows,metadata,calls,setReadOnly:()=>{readOnly=true;}};
}

describe('authorized Google Sheets',()=>{
  it('reads private sheets using the same stable identities and source questions as existing public connections',async()=>{
    const f=await fixture();const rows=await new AuthorizedSheetsProvider().read(f.sheet);
    expect(rows).toEqual(simpleSourceRows(f.sheet,f.rows));expect(rows[1]).toMatchObject({stableId:f.lead.stableSourceId,row:3,questions:[{question:'What is your budget?',answer:'Keep A'}]});expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('writes and verifies all four fields on the original moved row, preserving every source cell',async()=>{
    const f=await fixture();const original=f.rows.map(row=>row.slice());const values={sentStatus:'Sent',sharedTo:'Recipient',status:'Interested',feedback:'Call tomorrow'};
    expect(await new AuthorizedSheetsProvider().write(f.sheet,f.lead.stableSourceId,null,values)).toMatchObject(values);
    expect(f.rows[0].slice(-4)).toEqual(['Sent Status','Shared To','Feedback','Remark']);expect(f.rows[2].slice(-4)).toEqual(Object.values(values));
    expect(f.rows[1]).toEqual(original[1]);expect(f.rows[2].slice(0,5)).toEqual(original[2]);expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('checks actual Editor permission atomically and refuses a read-only Google account',async()=>{
    const f=await fixture();await verifyGoogleSheetEditor(f.sheet.spreadsheetId,f.credential.id,'legacy');expect(f.metadata).toEqual([]);
    f.setReadOnly();await expect(verifyGoogleSheetEditor(f.sheet.spreadsheetId,f.credential.id,'legacy')).rejects.toMatchObject({code:'SHEET_READ_ONLY',status:403});
    expect(f.rows[0]).toHaveLength(5);
  });
  it('keeps the update pending if the output columns disappear before verification',async()=>{
    const f=await fixture();const request=globalThis.fetch;let written=false;
    vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
      if(written&&input.includes('1%3A1'))return Response.json({values:[f.rows[0].slice(0,5)]});
      const response=await request(input,init);if(input.includes('/values:batchUpdateByDataFilter'))written=true;return response;
    }));
    await expect(new AuthorizedSheetsProvider().write(f.sheet,f.lead.stableSourceId,null,{sentStatus:'Sent',sharedTo:'Recipient'})).rejects.toThrow(/not confirmed/);
  });
  it('preserves external feedback edits instead of overwriting them through the API',async()=>{
    const f=await fixture();f.rows[0].push('Sent Status','Shared To','Feedback','Remark');f.rows[2].push('','','Converted','External remark');
    await expect(new AuthorizedSheetsProvider().write(f.sheet,f.lead.stableSourceId,null,{status:'Interested',feedback:'Application remark'})).rejects.toMatchObject({code:'SYNC_CONFLICT'});
    expect(f.rows[2].slice(-2)).toEqual(['Converted','External remark']);
  });
  it('stops when row metadata points to a different lead',async()=>{
    const f=await fixture();f.metadata.push({metadataId:101,metadataKey:'smartlead_oauth_legacy_42',metadataValue:f.lead.stableSourceId,location:{dimensionRange:{sheetId:42,startIndex:1,endIndex:2}}});
    await expect(new AuthorizedSheetsProvider().write(f.sheet,f.lead.stableSourceId,null,{sentStatus:'Sent',sharedTo:'Recipient'})).rejects.toThrow(/identity changed/);
    expect(f.calls.some(call=>call.url.includes('/values:batchUpdateByDataFilter'))).toBe(false);
  });
  it('upgrades an existing sheet and repairs feedback without resetting recipients, cursor or sending history',async()=>{
    const f=await fixture();f.rows.splice(1,1);await db.sheet.update({where:{id:f.sheet.id},data:{connectionType:'SIMPLE_PUBLIC',credentialId:null}});
    const employee=await db.employee.create({data:{organizationId:'legacy',name:'Recipient',phone:'+919800000001',projects:[]}});
    const sender=await db.sender.create({data:{organizationId:'legacy',name:'WhatsApp',provider:'DEMO',status:'CONNECTED'}});
    const rule=await db.distributionRule.create({data:{sheetId:f.sheet.id,senderId:sender.id,template:'Lead',enabled:true,recipients:{create:{employeeId:employee.id,position:0}}}});
    await assignLead(f.lead.id);const message=await db.message.findFirstOrThrow();await db.message.update({where:{id:message.id},data:{status:'SUBMITTED',uncertain:false}});
    await db.distributionRule.update({where:{id:rule.id},data:{cursor:7}});
    await db.lead.update({where:{id:f.lead.id},data:{status:'Interested',lastFeedback:'Arrange a visit'}});
    const sends=await db.job.count({where:{type:'SEND'}});
    await attachAuthorizedSheet(f.user,f.sheet.id,f.credential.id);await synchronizeSheet(f.sheet.id);await writebackLead(f.lead.id);
    expect(await db.lead.count({where:{sheetId:f.sheet.id}})).toBe(1);expect(await db.message.count()).toBe(1);expect(await db.job.count({where:{type:'SEND'}})).toBe(sends);
    expect(await db.distributionRule.findUnique({where:{id:rule.id}})).toMatchObject({cursor:7,enabled:true,senderId:sender.id});
    expect(f.rows[1].slice(-4)).toEqual(['Sent','Recipient','Interested','Arrange a visit']);expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('retains rotated access tokens and the background refresh token encrypted',async()=>{
    const f=await fixture();await db.googleCredential.update({where:{id:f.credential.id},data:{type:'OAUTH',encryptedValue:encrypt(JSON.stringify({access_token:'old',refresh_token:'private-refresh'}))}});mocks.refreshed=true;
    expect(await googleToken(f.credential.id,'legacy')).toBe('refreshed-token');const stored=await db.googleCredential.findUniqueOrThrow({where:{id:f.credential.id}});
    expect(JSON.parse(decrypt(stored.encryptedValue))).toMatchObject({access_token:'refreshed-token',refresh_token:'private-refresh'});expect(stored.encryptedValue).not.toContain('private-refresh');
  });
});

describe('Google authorization flow',()=>{
  it('remembers popup presentation and clears it after consent',async()=>{
    const f=await fixture();const started=await startGoogleAuthorization(f.user,{popup:true});
    expect(await googleAuthorizationUsesPopup()).toBe(true);
    const state=new URL(started.url).searchParams.get('state')!;
    await finishGoogleAuthorization(f.user,new URLSearchParams({state,code:'popup-code'}));
    expect(await googleAuthorizationUsesPopup()).toBe(false);
    await startGoogleAuthorization(f.user,{popup:true});await startGoogleAuthorization(f.user);
    expect(await googleAuthorizationUsesPopup()).toBe(false);
  });
  it('binds consent to the pasted link and current organisation and consumes state only once',async()=>{
    const f=await fixture();const url=`https://docs.google.com/spreadsheets/d/${f.sheet.spreadsheetId}/edit#gid=42`;
    const started=await startGoogleAuthorization(f.user,{url});const state=new URL(started.url).searchParams.get('state')!;
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({access_type:'offline',scope:['https://www.googleapis.com/auth/spreadsheets']}));
    const returned=new URL(await finishGoogleAuthorization(f.user,new URLSearchParams({state,code:'one-use-code'})));
    expect(returned.origin).toBe('http://localhost:3000');expect(returned.searchParams.get('sheet')).toBe(url);
    const credential=await db.googleCredential.findUniqueOrThrow({where:{id:returned.searchParams.get('credential')!}});expect(credential.organizationId).toBe(f.user.organizationId);expect(credential.encryptedValue).not.toContain('private-refresh-token');
    await expect(finishGoogleAuthorization(f.user,new URLSearchParams({state,code:'one-use-code'}))).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'});
  });
  it('rejects forged, expired and cross-organisation authorization state',async()=>{
    const f=await fixture();const started=await startGoogleAuthorization(f.user);const state=new URL(started.url).searchParams.get('state')!;
    await expect(finishGoogleAuthorization({...f.user,organizationId:'another-org'},new URLSearchParams({state,code:'test'}))).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'});
    expect(mocks.exchange).not.toHaveBeenCalled();
    const again=await startGoogleAuthorization(f.user);const next=new URL(again.url).searchParams.get('state')!;
    await db.setting.updateMany({where:{key:{startsWith:'google-oauth:'}},data:{value:{userId:f.user.id,organizationId:'legacy',at:Date.now()-601000}}});
    await expect(finishGoogleAuthorization(f.user,new URLSearchParams({state:next,code:'test'}))).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'});
  });
  it('handles denied consent without exchanging tokens or changing the sheet',async()=>{
    const f=await fixture();await db.sheet.update({where:{id:f.sheet.id},data:{connectionType:'SIMPLE_PUBLIC',credentialId:null}});
    const started=await startGoogleAuthorization(f.user,{sheetId:f.sheet.id});const state=new URL(started.url).searchParams.get('state')!;
    await expect(finishGoogleAuthorization(f.user,new URLSearchParams({state,error:'access_denied'}))).rejects.toMatchObject({code:'GOOGLE_AUTH_DENIED'});
    expect(mocks.exchange).not.toHaveBeenCalled();expect(await db.sheet.findUnique({where:{id:f.sheet.id}})).toMatchObject({connectionType:'SIMPLE_PUBLIC',credentialId:null});
  });
  it('requires background access and rejects read-only consent',async()=>{
    const f=await fixture();mocks.exchange.mockResolvedValueOnce({tokens:{access_token:'no-refresh'}});
    let started=await startGoogleAuthorization(f.user);let state=new URL(started.url).searchParams.get('state')!;
    await expect(finishGoogleAuthorization(f.user,new URLSearchParams({state,code:'test'}))).rejects.toThrow(/background access/);
    mocks.exchange.mockResolvedValueOnce({tokens:{access_token:'token',refresh_token:'refresh',scope:'https://www.googleapis.com/auth/spreadsheets.readonly'}});
    started=await startGoogleAuthorization(f.user);state=new URL(started.url).searchParams.get('state')!;
    await expect(finishGoogleAuthorization(f.user,new URLSearchParams({state,code:'test'}))).rejects.toThrow(/editing access/);
  });
  it('gives actionable setup errors without exposing the client secret',async()=>{
    const f=await fixture();vi.stubEnv('GOOGLE_CLIENT_SECRET','');expect(googleOAuthConfiguration()).toMatchObject({oauthConfigured:false,missing:['GOOGLE_CLIENT_SECRET']});
    await expect(startGoogleAuthorization(f.user,{sheetId:f.sheet.id})).rejects.toMatchObject({code:'GOOGLE_OAUTH_NOT_CONFIGURED'});
    vi.stubEnv('GOOGLE_CLIENT_SECRET','private-client-secret');vi.stubEnv('GOOGLE_REDIRECT_URI','https://wrong.example/callback');
    await expect(startGoogleAuthorization(f.user)).rejects.toMatchObject({code:'GOOGLE_OAUTH_NOT_CONFIGURED'});
  });
  it('requires Google authorization before inspecting or connecting a new sheet',async()=>{
    const f=await fixture();const request=(data:unknown)=>new Request('http://localhost:3000',{method:'POST',body:JSON.stringify(data)});
    await expect(simpleAction(['sheets','inspect'],'POST',request({url:`https://docs.google.com/spreadsheets/d/${f.sheet.spreadsheetId}/edit`}),f.user)).rejects.toThrow();
    const result=await simpleAction(['sheets'],'POST',request({spreadsheetId:f.sheet.spreadsheetId,worksheetId:42,credentialId:f.credential.id,columnMapping:{customerName:'Name',mobile:'Phone'}}),f.user);
    expect(result).toMatchObject({id:f.sheet.id,reauthorized:true});expect(await db.sheet.count()).toBe(1);
  });
});
