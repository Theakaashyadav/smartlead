import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestModels } from './database-fixture';
import { db } from '@/lib/db';
import { registerWebClient, WebWhatsAppProvider } from '@/lib/whatsapp';

beforeEach(async()=>{
  await clearTestModels(['Sender','Setting']);
  await db.organization.upsert({where:{id:'legacy'},create:{id:'legacy',name:'Test organisation'},update:{}});
});
afterEach(()=>{registerWebClient('group-browser',null);vi.unstubAllGlobals();});
afterAll(()=>db.$disconnect());

async function browser(){
  const sender=await db.sender.create({data:{id:'group-browser',organizationId:'legacy',name:'WhatsApp',provider:'WEB',status:'CONNECTED'}});
  const client={
    getState:vi.fn(async()=> 'CONNECTED'),info:{wid:{user:'919876543210',_serialized:'919876543210@c.us'}},
    getContacts:vi.fn(async()=>[{id:{_serialized:'919876543211@c.us'},number:'919876543211',name:'Saved contact'}]),
    getNumberId:vi.fn(),getChatById:vi.fn(),getContactLidAndPhone:vi.fn().mockResolvedValue([]),
    sendMessage:vi.fn(async()=>({id:{_serialized:'group-message'}})),pupPage:{evaluate:vi.fn().mockResolvedValue(undefined)},
  };
  registerWebClient(sender.id,client as unknown as import('whatsapp-web.js').Client);
  return {sender,client,provider:new WebWhatsAppProvider(sender)};
}

describe('WhatsApp Web groups',()=>{
  it('loads names from group metadata without serializing chat messages and replaces stale cached groups',async()=>{
    const f=await browser();
    await db.setting.create({data:{key:'whatsapp-contacts:group-browser',value:{contacts:[{phone:'120363999999@g.us',name:'Stale group',kind:'group'}]}}});
    vi.stubGlobal('window',{require:()=>({Chat:{getModelsArray:()=>[
      {id:{_serialized:'120363000001@g.us',user:'120363000001'},groupMetadata:{subject:'Sales team'}},
      {id:{_serialized:'919876543210-1234567890@g.us',user:'919876543210-1234567890'},name:'Older group'},
      {id:{_serialized:'120363000003@g.us',user:'120363000003'},groupMetadata:{subject:'Left group',isPastParticipant:true}},
      {id:{_serialized:'12345@newsletter',user:'12345'},name:'Channel'},
    ]}})});
    f.client.pupPage.evaluate.mockImplementation(async(fn:any)=>String(fn).includes('getModelsArray')?fn():undefined);
    expect(await f.provider.refreshContacts()).toEqual([
      {phone:'919876543210-1234567890@g.us',name:'Older group',kind:'group'},
      {phone:'120363000001@g.us',name:'Sales team',kind:'group'},
      {phone:'+919876543211',name:'Saved contact',nameSource:'saved'},
    ]);
  });
  it('sends to a group JID after checking membership, including migrated private IDs',async()=>{
    const f=await browser(),id='120363000001@g.us';
    f.client.getChatById.mockResolvedValue({isGroup:true,participants:[{id:{_serialized:'12345@lid'},isAdmin:false}]});
    f.client.getContactLidAndPhone.mockResolvedValue([{pn:'919876543210@c.us',lid:'12345@lid'}]);
    await expect(f.provider.sendMessage({to:id,body:'New lead',parameters:[]})).resolves.toEqual({id:'group-message',status:'SUBMITTED'});
    expect(f.client.sendMessage).toHaveBeenCalledWith(id,'New lead',{sendSeen:false});expect(f.client.getNumberId).not.toHaveBeenCalled();
    expect(f.client.getContactLidAndPhone).toHaveBeenCalledWith(['919876543210@c.us']);
  });
  it('rejects unavailable groups, departed memberships and announcements restricted to admins before sending',async()=>{
    const f=await browser(),input={to:'120363000001@g.us',body:'New lead',parameters:[]};
    f.client.getChatById.mockRejectedValueOnce(new Error('Unknown group'));await expect(f.provider.sendMessage(input)).rejects.toThrow('unavailable');
    f.client.getChatById.mockResolvedValueOnce({isGroup:true,participants:[]});await expect(f.provider.sendMessage(input)).rejects.toThrow('no longer a member');
    f.client.getChatById.mockResolvedValueOnce({isGroup:true,isReadOnly:true,participants:[{id:{_serialized:'919876543210@c.us'},isAdmin:false}]});
    await expect(f.provider.sendMessage(input)).rejects.toThrow('Only group admins');expect(f.client.sendMessage).not.toHaveBeenCalled();
  });
});
