import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, databaseTransaction, usingSQLite } from '@/lib/db';
import { assignLead, dispatchMessage, processJob, writebackLead } from '@/lib/engine';
import { AppError, encrypt } from '@/lib/security';
import { MetaWhatsAppProvider, UncertainDelivery } from '@/lib/whatsapp';
import { deliveryBackfillLeads, deliveryValues, queueDeliveryWriteback } from '@/lib/delivery';
import { PublicSheetsProvider } from '@/lib/public-sheets';
import { GoogleSheetsProvider, type SheetProvider } from '@/lib/google';
import { clearTestModels } from './database-fixture';
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
  it('uses the successful message recipient when the lead has since been reassigned',async()=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    await assignLead(f.lead.id,f.recipients[1].id,undefined,true);
    const pending=await db.message.findFirstOrThrow({where:{leadId:f.lead.id,status:'QUEUED'}});
    f.send.mockRejectedValueOnce(new AppError(400,'Rejected'));
    await dispatchMessage(pending.id,f.provider);await writebackLead(f.lead.id,f.sheetProvider);
    expect(f.write.mock.calls[0][3]).toEqual({sentStatus:'Sent',sharedTo:'Original recipient'});
  });
  it('does not resend a successful message when writing to Google fails',async()=>{
    const f=await fixture();await dispatchMessage(f.message.id,f.provider);
    vi.spyOn(PublicSheetsProvider.prototype,'write').mockRejectedValue(new AppError(502,'Google temporarily unavailable'));
    const job=await db.job.findFirstOrThrow({where:{key:{startsWith:'writeback:delivery:'}}});
    await processJob(job.id);await dispatchMessage(f.message.id,f.provider);
    expect(f.send).toHaveBeenCalledOnce();expect((await db.message.findUniqueOrThrow({where:{id:f.message.id}})).status).toBe('SUBMITTED');
    expect(await db.job.findUnique({where:{id:job.id}})).toMatchObject({status:'PENDING',attempts:1});
  });
  it('deduplicates backfills without changing completed jobs or versions again',async()=>{
    const f=await fixture();const first=await databaseTransaction(tx=>queueDeliveryWriteback(tx,f.message,'backfill-v1'));
    await db.job.update({where:{id:first.id},data:{status:'COMPLETED'}});
    const version=(await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).version;
    const second=await databaseTransaction(tx=>queueDeliveryWriteback(tx,f.message,'backfill-v1'));
    expect(second).toMatchObject({id:first.id,status:'COMPLETED'});expect((await db.lead.findUniqueOrThrow({where:{id:f.lead.id}})).version).toBe(version);
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
    expect(add.body.data[0]).toEqual({range:"'Sheet1'!F1:G1",values:[['Sent Status','Shared To']]});
    const write=requests.find(r=>r.url.includes('/values:batchUpdateByDataFilter'))!;
    expect(write.body).toEqual({valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:100}},values:[[null,null,null,null,null,'Sent','Original recipient']]}]});
    expect((await db.sheet.findUniqueOrThrow({where:{id:sheet.id}})).columnMapping).toMatchObject({leadId:'ID',sentStatus:'Sent Status',sharedTo:'Shared To'});
  });
});
