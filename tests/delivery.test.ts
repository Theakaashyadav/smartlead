import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, databaseTransaction, usingSQLite } from '@/lib/db';
import { assignLead, dispatchMessage, processJob, saveFeedback, writebackLead } from '@/lib/engine';
import { AppError, encrypt } from '@/lib/security';
import { MetaWhatsAppProvider, UncertainDelivery } from '@/lib/whatsapp';
import { deliveryBackfillLeads, deliveryValues, queueDeliveryWriteback } from '@/lib/delivery';
import { PublicSheetsProvider } from '@/lib/public-sheets';
import { GoogleSheetsProvider, type SheetProvider } from '@/lib/google';
import { clearTestModels } from './database-fixture';
import { recoverSheetOutputs, recoverUnavailableSheetWrites } from '@/lib/sheet-output-recovery';
vi.mock('google-auth-library',()=>({GoogleAuth:class{async getAccessToken(){return 'test-google-token';}},OAuth2Client:class{}}));

beforeEach(async()=>{
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Test organisation'},update:{}});
  await db.setting.create({data:{key:'feedback:remoteRequired',value:false}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
afterAll(()=>db.$disconnect());
async function fixture(){
  const sender=await db.sender.create({data:{organizationId:'legacy',name:'Test WhatsApp',provider:'DEMO',status:'CONNECTED'}});
  const recipients=await Promise.all(['Original recipient','New recipient'].map((name,i)=>db.employee.create({data:{organizationId:'legacy',name,phone:`+91987654321${i}`,projects:[]}})));
  const sheet=await db.sheet.create({data:{organizationId:'legacy',name:'Public leads',project:'Sales',spreadsheetId:'public-delivery-test-sheet',connectionType:'SIMPLE_PUBLIC',columnMapping:{customerName:'Name',mobile:'Phone'},rule:{create:{senderId:sender.id,template:'New lead',enabled:true,recipients:{create:recipients.map((e,position)=>({employeeId:e.id,position}))}}}}});
  const lead=await db.lead.create({data:{sheetId:sheet.id,stableSourceId:'source-a',sourceRow:2,sourceFingerprint:'test',customerName:'Customer',mobile:'+919800000000',project:'Sales'}});
  await assignLead(lead.id);
  const message=await db.message.findFirstOrThrow({where:{leadId:lead.id}});
  const send=vi.fn(async()=>({id:'provider-success',status:'SUBMITTED' as const}));
  const provider={sendMessage:send} as never;
  const write=vi.fn<SheetProvider['write']>(async()=>{});
  return {lead,message,recipients,send,provider,write,sheetProvider:{read:vi.fn(),write}};
}

describe('Sent Status and Shared To',()=>{
  it('marks a lead only after successful submission and queues a separate sheet job',async()=>{
    const f=await fixture();
    await writebackLead(f.lead.id,f.sheetProvider);expect(f.write.mock.calls[0][3]).toEqual({sentStatus:'',sharedTo:''});
    await dispatchMessage(f.message.id,f.provider);
    await writebackLead(f.lead.id,f.sheetProvider);
    expect(f.write.mock.calls.at(-1)?.[3]).toEqual({sentStatus:'Sent',sharedTo:'Original recipient'});
    expect(await db.job.count({where:{key:{startsWith:`writeback:delivery:${f.message.id}:`}}})).toBe(1);
    expect((await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).status).toBe('New');
  });
  it.each([new AppError(400,'Provider rejected the recipient'),new UncertainDelivery('Unknown outcome')])('does not mark a rejected or uncertain send as Sent (%s)',async error=>{
    const f=await fixture();f.send.mockRejectedValueOnce(error);
    await dispatchMessage(f.message.id,f.provider);await writebackLead(f.lead.id,f.sheetProvider);
    expect(f.write.mock.calls[0][3]).toEqual({sentStatus:'',sharedTo:''});
    expect(await db.job.count({where:{key:{startsWith:'writeback:delivery:'}}})).toBe(0);
  });
  it('keeps the successful recipient and prevents reassignment from sending an already-sent lead again',async()=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    expect(await assignLead(f.lead.id,f.recipients[1].id,undefined,true)).toMatchObject({assigned:false,reason:'Already sent'});
    expect(await db.message.count({where:{leadId:f.lead.id,status:'QUEUED'}})).toBe(0);
    await writebackLead(f.lead.id,f.sheetProvider);expect(f.send).toHaveBeenCalledOnce();
    expect(f.write.mock.calls[0][3]).toEqual({sentStatus:'Sent',sharedTo:'Original recipient'});
  });
  it('does not resend a successful message when writing to Google fails',async()=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    vi.spyOn(PublicSheetsProvider.prototype,'write').mockRejectedValue(new AppError(502,'Google temporarily unavailable'));
    const job=await db.job.findFirstOrThrow({where:{key:{startsWith:'writeback:delivery:'}}});
    await db.job.update({where:{id:job.id},data:{runAt:new Date(0)}});
    await processJob(job.id);await dispatchMessage(f.message.id,f.provider);
    expect(f.send).toHaveBeenCalledOnce();expect((await db.message.findUniqueOrThrow({where:{id:f.message.id}})).status).toBe('SUBMITTED');
    expect(await db.job.findUnique({where:{id:job.id}})).toMatchObject({status:'PENDING',attempts:1});
  });
  it.each(['SIMPLE_PUBLIC','SIMPLE_SERVICE_ACCOUNT'])('repairs feedback and remark from a delayed delivery job on %s',async connectionType=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    await db.sheet.update({where:{id:f.lead.sheetId},data:{connectionType}});
    const assignment=await db.assignment.findFirstOrThrow({where:{leadId:f.lead.id,isPrimary:true},include:{lead:true}});
    await saveFeedback(assignment.id,{status:'Interested',remarks:'Call tomorrow afternoon',version:assignment.lead.version});
    await writebackLead(f.lead.id,f.sheetProvider,{deliveryOnly:true});
    expect(f.write.mock.calls[0][3]).toEqual({sentStatus:'Sent',sharedTo:'Original recipient',status:'Interested',feedback:'Call tomorrow afternoon'});
    expect(await db.lead.findUnique({where:{id:f.lead.id}})).toMatchObject({writebackStatus:'SYNCED',managedSnapshot:{status:'Interested',feedback:'Call tomorrow afternoon',__publicOutputV2:'1'}});
  });
  it('keeps read-only sheet updates retryable and saves them after sharing is corrected',async()=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    const job=await db.job.findFirstOrThrow({where:{key:{startsWith:'writeback:delivery:'}}});
    await db.job.update({where:{id:job.id},data:{attempts:7,runAt:new Date(0)}});
    const write=vi.spyOn(PublicSheetsProvider.prototype,'write').mockRejectedValueOnce(new AppError(403,'Sheet is read-only','SHEET_READ_ONLY')).mockResolvedValue({});
    await processJob(job.id);
    expect(await db.job.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({status:'PENDING',attempts:7,error:'Sheet is read-only'});
    await db.job.update({where:{id:job.id},data:{runAt:new Date(0)}});await processJob(job.id);
    expect(await db.job.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({status:'COMPLETED',error:null});
    expect(write).toHaveBeenLastCalledWith(expect.anything(),f.lead.stableSourceId,null,{sentStatus:'Sent',sharedTo:'Original recipient'});
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('recovers exhausted editor updates while preserving completed writes, conflicts and failed sends',async()=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    const error='Google Sheets editor is temporarily unavailable. The sheet update will retry.';
    await db.job.createMany({data:[
      {organizationId:'legacy',key:'editor-dead',type:'WRITEBACK',entityId:f.lead.id,status:'DEAD',attempts:8,error},
      {organizationId:'legacy',key:'capacity-dead',type:'WRITEBACK',entityId:f.lead.id,status:'DEAD',attempts:8,error:'The hosting server cannot start Chromium with its current process or memory limits. Sheet update will retry (browser-launch).'},
      {organizationId:'legacy',key:'editor-done',type:'WRITEBACK',entityId:f.lead.id,status:'COMPLETED',attempts:1,error},
      {organizationId:'legacy',key:'conflict-dead',type:'WRITEBACK',entityId:f.lead.id,status:'DEAD',attempts:8,error:'Managed cells changed outside SmartLead'},
      {organizationId:'legacy',key:'send-dead',type:'SEND',entityId:f.message.id,status:'DEAD',attempts:8,error},
    ]});
    expect(await recoverUnavailableSheetWrites()).toBe(2);expect(await recoverUnavailableSheetWrites()).toBe(0);
    expect(await db.job.findUniqueOrThrow({where:{key:'editor-dead'}})).toMatchObject({status:'PENDING',attempts:0,error:null});
    expect(await db.job.findUniqueOrThrow({where:{key:'capacity-dead'}})).toMatchObject({status:'PENDING',attempts:0,error:null});
    expect(await db.job.findUniqueOrThrow({where:{key:'editor-done'}})).toMatchObject({status:'COMPLETED',attempts:1});
    expect(await db.job.findUniqueOrThrow({where:{key:'conflict-dead'}})).toMatchObject({status:'DEAD',attempts:8});
    expect(await db.job.findUniqueOrThrow({where:{key:'send-dead'}})).toMatchObject({status:'DEAD',attempts:8});
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('deduplicates backfills without changing completed jobs or versions again',async()=>{
    const f=await fixture();const first=await databaseTransaction(tx=>queueDeliveryWriteback(tx,f.message,'backfill-v1'));
    await db.job.update({where:{id:first.id},data:{status:'COMPLETED'}});
    const version=(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).version;
    const second=await databaseTransaction(tx=>queueDeliveryWriteback(tx,f.message,'backfill-v1'));
    expect(second).toMatchObject({id:first.id,status:'COMPLETED'});expect((await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).version).toBe(version);
  });
  it('recovers existing sheet outputs once without creating or retrying sends',async()=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    const jobs=await db.job.count({where:{type:'SEND'}});
    expect(await recoverSheetOutputs()).toBe(1);
    expect(await recoverSheetOutputs()).toBe(0);
    expect(await db.job.count({where:{key:`writeback:outputs-v2:${f.lead.id}`}})).toBe(1);
    expect(await db.job.count({where:{type:'SEND'}})).toBe(jobs);expect(f.send).toHaveBeenCalledOnce();
    await writebackLead(f.lead.id,f.sheetProvider);
    expect(await db.job.findUnique({where:{key:`writeback:outputs-v2:${f.lead.id}`}})).toMatchObject({status:'COMPLETED'});
  });
  it('backfills successful unredacted leads even when MongoDB stores no optional redaction field',async()=>{
    const f=await fixture();expect(await deliveryBackfillLeads(f.lead.sheetId)).toEqual([]);
    await dispatchMessage(f.message.id,f.provider);
    if(!usingSQLite)await db.lead.update({where:{id:f.lead.id},data:{redactedAt:{unset:true}}});
    expect((await deliveryBackfillLeads(f.lead.sheetId)).map(lead=>lead.id)).toEqual([f.lead.id]);
    await db.lead.update({where:{id:f.lead.id},data:{redactedAt:new Date()}});
    expect(await deliveryBackfillLeads(f.lead.sheetId)).toEqual([]);
    await db.lead.update({where:{id:f.lead.id},data:{redactedAt:null,sourceDeleted:true}});
    expect(await deliveryBackfillLeads(f.lead.sheetId)).toEqual([]);
  });
  it('repairs an uncertain result from a verified provider receipt and ignores duplicate receipts',async()=>{
    const f=await fixture();
    const sender=await db.sender.update({where:{id:f.message.senderId},data:{provider:'META',encryptedCredentials:encrypt(JSON.stringify({phoneNumberId:'test-number',accessToken:'test-token'}))}});
    await db.message.update({where:{id:f.message.id},data:{status:'FAILED',uncertain:true,providerMessageId:'meta-message'}});
    const provider=new MetaWhatsAppProvider(sender);
    const event={entry:[{changes:[{value:{metadata:{phone_number_id:'test-number'},statuses:[{id:'meta-message',status:'sent'}]}}]}]};
    await provider.handleIncomingEvents(event);await provider.handleIncomingEvents(event);
    await writebackLead(f.lead.id,f.sheetProvider);
    expect((await db.message.findUniqueOrThrow({where:{id:f.message.id}}))).toMatchObject({status:'SENT',uncertain:false});
    expect(f.write.mock.calls[0][3]).toEqual({sentStatus:'Sent',sharedTo:'Original recipient'});
    expect(await db.job.count({where:{key:{startsWith:'writeback:delivery:'}}})).toBe(1);
  });
  it('retains every successful recipient once and excludes pending, failed and uncertain records',()=>{
    const row=(status:string,name:string,uncertain=false)=>({status,uncertain,assignment:{employee:{name}}});
    expect(deliveryValues([row('READ','A'),row('SUBMITTED','B'),row('SENT','A'),row('DELIVERED','C'),row('QUEUED','D'),row('FAILED','E'),row('SUBMITTED','F',true)])).toEqual({sentStatus:'Sent',sharedTo:'A, B, C'});
  });
  it('appends API delivery columns beyond unheaded source data and writes only the identified row outputs',async()=>{
    const f=await fixture();
    const sheet=await db.sheet.update({where:{id:f.lead.sheetId},data:{connectionType:'SIMPLE_SERVICE_ACCOUNT',columnMapping:{leadId:'ID',customerName:'Name',mobile:'Phone'}}});
    const headers=['ID','Name','Phone'];const source=[f.lead.stableSourceId,'Customer','9876543210','keep this','keep that'];
    const requests:Array<{url:string;body:any}>=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      const body=init?.body?JSON.parse(String(init.body)):null;requests.push({url,body});
      if(url.includes('/values:batchUpdateByDataFilter'))return Response.json({totalUpdatedRows:1});
      if(url.includes('/values:batchGetByDataFilter'))return Response.json({valueRanges:[{valueRange:{values:[source]}}]});
      if(url.includes('/values:batchUpdate')){headers.push('','',...body.data[0].values[0]);return Response.json({totalUpdatedRows:1});}
      return Response.json({values:url.includes('1%3A1')?[headers]:[headers,source]});
    }));
    await new GoogleSheetsProvider().write(sheet,f.lead.stableSourceId,100,{sentStatus:'Sent',sharedTo:'Original recipient'});
    const add=requests.find(r=>r.url.includes('/values:batchUpdate')&&!r.url.includes('ByDataFilter'))!;
    expect(add.body.data[0]).toEqual({range:"'Sheet1'!F1:I1",values:[['Sent Status','Shared To','Feedback','Remark']]});
    const write=requests.find(r=>r.url.includes('/values:batchUpdateByDataFilter'))!;
    expect(write.body).toEqual({valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:100}},values:[[null,null,null,null,null,'Sent','Original recipient',null,null]]}]});
    expect((await db.sheet.findUniqueOrThrow({where:{id:sheet.id}})).columnMapping).toMatchObject({leadId:'ID',sentStatus:'Sent Status',sharedTo:'Shared To'});
  });
  it('migrates legacy API feedback to Remark and moves all four columns while retaining source cells',async()=>{
    const f=await fixture();
    const sheet=await db.sheet.update({where:{id:f.lead.sheetId},data:{connectionType:'SIMPLE_SERVICE_ACCOUNT',columnMapping:{leadId:'ID',customerName:'Name',mobile:'Phone',status:'lead_status',feedback:'Feedback'}}});
    await db.lead.update({where:{id:f.lead.id},data:{managedSnapshot:{status:'New',feedback:'Old note',sentStatus:'Sent',sharedTo:'Original recipient'}}});
    const rows=[['ID','Name','Phone','lead_status','Feedback','Sent Status','Shared To','Source Extra'],[f.lead.stableSourceId,'Customer','9876543210','New','Old note','Sent','Original recipient','Keep source']];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      const body=init?.body?JSON.parse(String(init.body)):null;
      if(url.includes('/values:batchUpdateByDataFilter')){body.data[0].values[0].forEach((value:string|null,i:number)=>{if(value!==null)rows[1][i]=value;});return Response.json({totalUpdatedRows:1});}
      if(url.includes('/values:batchGetByDataFilter'))return Response.json({valueRanges:[{valueRange:{values:[rows[1]]}}]});
      if(url.includes('/values:batchUpdate')){
        for(const update of body.data){const letters=update.range.match(/!([A-Z]+)1/)![1];let index=0;for(const letter of letters)index=index*26+letter.charCodeAt(0)-64;update.values[0].forEach((value:string,i:number)=>{rows[0][index-1+i]=value;});}
        return Response.json({totalUpdatedRows:1});
      }
      if(url.endsWith(':batchUpdate')){
        for(const {moveDimension:move} of body.requests){for(const row of rows){while(row.length<rows[0].length)row.push('');const cells=row.splice(move.source.startIndex,1);row.splice(move.destinationIndex>move.source.startIndex?move.destinationIndex-1:move.destinationIndex,0,...cells);}}
        return Response.json({});
      }
      return Response.json({values:url.includes('1%3A1')?[rows[0]]:rows});
    }));
    await new GoogleSheetsProvider().write(sheet,f.lead.stableSourceId,100,{sentStatus:'Sent',sharedTo:'Original recipient',status:'Interested',feedback:'Site visit Sunday'});
    expect(rows[0]).toEqual(['ID','Name','Phone','lead_status','Source Extra','Sent Status','Shared To','Feedback','Remark']);
    expect(rows[1]).toEqual([f.lead.stableSourceId,'Customer','9876543210','New','Keep source','Sent','Original recipient','Interested','Site visit Sunday']);
  });
});
