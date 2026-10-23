import { db, databaseTransaction } from './db';
import { queueDeliveryWriteback } from './delivery';
import { AppError, decrypt } from './security';
import { isDemo } from './config';
import type { Sender } from '@/generated/mongo';
import { existsSync } from 'node:fs';
import { EncryptedAuthStore } from './whatsapp-archives';
import QRCode from 'qrcode';
import { phoneSchema } from './validation';
import type { WhatsAppContact } from './simple-shared';
import { nativeWhatsAppLogin, NativeWhatsAppProvider } from './whatsapp-native';
import { installWhatsAppCompatibility } from './whatsapp-compat';
import { socketWhatsApp } from './whatsapp-mode';
import { SocketWhatsAppProvider } from './whatsapp-socket';

export class UncertainDelivery extends Error {}
export interface SendInput {to:string;body:string;template?:string|null;language?:string;parameters:string[];messageId?:string}
export interface WhatsAppProvider {
  connect(options?:{interactive?:boolean}):Promise<void>;
  disconnect():Promise<void>;
  getConnectionStatus():Promise<string>;
  getQRCode():Promise<string|null>;
  sendMessage(input:SendInput):Promise<{id:string;status:'SUBMITTED'}>;
  getMessageStatus(id:string):Promise<string|null>;
  handleIncomingEvents(event:unknown):Promise<void>;
}
export class DemoWhatsAppProvider implements WhatsAppProvider {
  constructor(private sender:Sender) {}
  async connect(){await db.sender.update({where:{id:this.sender.id},data:{status:'CONNECTED',lastConnectedAt:new Date(),lastError:null,qrCode:null}});}
  async disconnect(){await db.sender.update({where:{id:this.sender.id},data:{status:'DISCONNECTED',qrCode:null}});}
  async getConnectionStatus(){return (await db.sender.findUniqueOrThrow({where:{id:this.sender.id}})).status;}
  async getQRCode(){return null;}
  async sendMessage(_input:SendInput){if(await this.getConnectionStatus()!=='CONNECTED')throw new AppError(409,'Demo sender is disconnected');return {id:`demo-${crypto.randomUUID()}`,status:'SUBMITTED' as const};}
  async getMessageStatus(){return 'SUBMITTED';}
  async handleIncomingEvents(){}
}
export class MetaWhatsAppProvider implements WhatsAppProvider {
  constructor(private sender:Sender){}
  private credentials(){if(!this.sender.encryptedCredentials)throw new AppError(400,'Configure a phone number ID and access token');return JSON.parse(decrypt(this.sender.encryptedCredentials)) as {phoneNumberId:string;accessToken:string};}
  private url(){const {phoneNumberId}=this.credentials();if(!/^\d+$/.test(phoneNumberId))throw new AppError(400,'Invalid Meta phone number ID');return `https://graph.facebook.com/${process.env.META_GRAPH_VERSION||'v25.0'}/${phoneNumberId}`;}
  async connect(){const c=this.credentials();const r=await fetch(this.url(),{headers:{Authorization:`Bearer ${c.accessToken}`},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new AppError(400,'Meta authorization failed. Verify the access token and phone number ID.');await db.sender.update({where:{id:this.sender.id},data:{status:'CONNECTED',lastConnectedAt:new Date(),lastError:null}});}
  async disconnect(){await db.sender.update({where:{id:this.sender.id},data:{status:'DISCONNECTED'}});}
  async getConnectionStatus(){return this.sender.status;}
  async getQRCode(){return null;}
  async sendMessage(input:SendInput){
    if(!input.template)throw new AppError(400,'Set an approved Meta template for this sheet. Automatic notifications always use approved templates.');
    const payload={messaging_product:'whatsapp',to:input.to.replace('+',''),type:'template',template:{name:input.template,language:{code:input.language||'en'},components:[{type:'body',parameters:input.parameters.map(text=>({type:'text',text}))}]}};
    let response:Response;
    try{response=await fetch(`${this.url()}/messages`,{method:'POST',headers:{Authorization:`Bearer ${this.credentials().accessToken}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});}catch{throw new UncertainDelivery('Provider request timed out or connection was interrupted; acceptance is unknown. Verify in Meta before resending.');}
    if(!response.ok){if(response.status>=500)throw new UncertainDelivery('Meta returned a server error; acceptance is unknown.');throw new AppError(400,`Meta rejected the notification (HTTP ${response.status}). Check template approval, recipient authorization and account limits.`);}
    const result=await response.json();
    if(!result.messages?.[0]?.id)throw new UncertainDelivery('Meta returned no message identifier; acceptance is unknown.');
    return {id:result.messages[0].id,status:'SUBMITTED' as const};
  }
  async getMessageStatus(id:string){return (await db.message.findUnique({where:{providerMessageId:id}}))?.status||null;}
  async handleIncomingEvents(event:unknown){
    const payload=event as {entry?:Array<{changes?:Array<{value?:{metadata?:{phone_number_id?:string};statuses?:Array<{id:string;status:string;timestamp?:string}>}}>} >};
    const rank:Record<string,number>={SUBMITTED:1,SENT:2,DELIVERED:3,READ:4,FAILED:0};
    for(const entry of payload.entry||[])for(const change of entry.changes||[]){
      if(change.value?.metadata?.phone_number_id!==this.credentials().phoneNumberId)continue;
      for(const status of change.value?.statuses||[]){
        const message=await db.message.findUnique({where:{providerMessageId:status.id}});
        const value=status.status.toUpperCase();
        if(!message||message.senderId!==this.sender.id||!['SENT','DELIVERED','READ','FAILED'].includes(value))continue;
        if(message.status===value)continue;
        if(value==='FAILED' && ['DELIVERED','READ'].includes(message.status))continue;
        if(value!=='FAILED' && (rank[value]||0)<(rank[message.status]||0))continue;
        const date=status.timestamp?new Date(Number(status.timestamp)*1000):new Date();
        await databaseTransaction(async tx=>{
          await tx.message.update({where:{id:message.id},data:{status:value,uncertain:false,...(value==='SENT'?{sentAt:date}:value==='DELIVERED'?{deliveredAt:date}:value==='READ'?{readAt:date}:{failedAt:date,failureReason:'Provider reported message delivery failure'})}});
          await queueDeliveryWriteback(tx,message,`status:${value}:${message.providerMessageId}`);
        });
      }
    }
  }
}

type WClient=import('whatsapp-web.js').Client;
const clients=new Map<string,WClient>();
export function registerWebClient(id:string,client:WClient|null){if(client)clients.set(id,client);else clients.delete(id);}
export class WebWhatsAppProvider implements WhatsAppProvider {
  constructor(private sender:Sender){}
  async connect(){
    if(clients.has(this.sender.id))return;
    const mod=await import('whatsapp-web.js');
    const {Client,RemoteAuth}=mod.default||mod;
    const browser=[process.env.CHROME_PATH,...(process.platform==='win32'?['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']:[])].find(p=>p&&existsSync(p));
    const client=new Client({userAgent:false as unknown as string,webVersionCache:{type:'none'},authStrategy:new RemoteAuth({clientId:this.sender.id,dataPath:process.env.WHATSAPP_SESSION_DIR||'data/sessions',store:new EncryptedAuthStore(),backupSyncIntervalMs:60000}),puppeteer:{headless:true,executablePath:browser,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']}});
    clients.set(this.sender.id,client);
    const update=(data:Record<string,unknown>)=>db.sender.update({where:{id:this.sender.id},data}).catch(()=>{});
    client.on('qr',async qr=>{await update({status:'WAITING_QR',qrCode:await QRCode.toDataURL(qr),lastError:null});});
    client.on('ready',async()=>{await update({status:'CONNECTED',qrCode:null,phone:client.info?.wid?.user?`+${client.info.wid.user}`:null,lastConnectedAt:new Date(),lastError:null});await this.reconcileMessages().catch(()=>{});await this.refreshContacts().catch(()=>{});});
    client.on('auth_failure',async()=>{clients.delete(this.sender.id);await update({status:'AUTH_REQUIRED',qrCode:null,lastError:'Authentication failed. Reconnect and scan a new QR code.'});});
    client.on('disconnected',async()=>{clients.delete(this.sender.id);await update({status:'DISCONNECTED',qrCode:null});});
    // Unofficial acknowledgments are intentionally not translated into confirmed delivery/read events.
    client.on('message_ack',()=>{});
    await update({status:'CONNECTING',qrCode:null});
    client.initialize().catch(async error=>{clients.delete(this.sender.id);await client.destroy().catch(()=>{});console.error(JSON.stringify({event:'whatsapp_initialize_failed',message:error instanceof Error?error.message.slice(0,1500):'Unknown browser error'}));await update({status:'ERROR',lastError:'Could not connect to WhatsApp. Please try again.',qrCode:null});});
  }
  async disconnect(){const c=clients.get(this.sender.id);if(c){await c.logout().catch(()=>{});await c.destroy().catch(()=>{});clients.delete(this.sender.id);}await new EncryptedAuthStore().delete({session:`RemoteAuth-${this.sender.id}`});await db.sender.update({where:{id:this.sender.id},data:{status:'DISCONNECTED',qrCode:null}});}
  async getConnectionStatus(){const c=clients.get(this.sender.id);if(!c)return 'DISCONNECTED';return (await c.getState())==='CONNECTED'?'CONNECTED':'CONNECTING';}
  async getQRCode(){return (await db.sender.findUniqueOrThrow({where:{id:this.sender.id}})).qrCode;}
  async refreshContacts(){
    const client=clients.get(this.sender.id);if(!client||await this.getConnectionStatus()!=='CONNECTED')throw new AppError(409,'WhatsApp is disconnected','DISCONNECTED');
    try{
      await client.pupPage!.evaluate(installWhatsAppCompatibility).catch(()=>{});
      // Full chat serialization also reads old messages. A damaged message must
      // not prevent selecting otherwise valid contacts from this account.
      const [contacts,chats]=await Promise.allSettled([client.getContacts(),client.pupPage!.evaluate(()=>{
        const app=window as unknown as {require:(name:string)=>{Chat:{getModelsArray:()=>Array<{id:{_serialized:string;user:string};name?:string;formattedTitle?:string}>}}};
        return app.require('WAWebCollections').Chat.getModelsArray().filter(c=>/@(c\.us|lid)$/.test(c.id._serialized)).map(c=>({id:c.id._serialized,name:c.name||c.formattedTitle||'',number:c.id.user}));
      })]);
      if(contacts.status==='rejected'&&chats.status==='rejected')throw contacts.reason;
      const people=new Map<string,WhatsAppContact>();
      const records=[...(contacts.status==='fulfilled'?contacts.value:[]).filter(c=>!c.isGroup&&!c.isMe&&c.isWAContact!==false).map(c=>({id:c.id._serialized,name:c.name||c.pushname||'',number:c.number})),...(chats.status==='fulfilled'?chats.value||[]:[])];
      const lids=[...new Set(records.filter(r=>r.id.endsWith('@lid')).map(r=>r.id))];
      const numbers=new Map<string,string>();
      for(let i=0;i<lids.length;i+=20){
        const resolved=await Promise.allSettled(lids.slice(i,i+20).map(id=>client.getContactLidAndPhone([id])));
        for(const result of resolved)if(result.status==='fulfilled')for(const r of result.value)if(r.lid&&r.pn)numbers.set(r.lid,r.pn);
      }
      for(const record of records){
        const raw=record.id.endsWith('@lid')?numbers.get(record.id)?.split('@')[0]:record.id.endsWith('@c.us')?record.number:undefined;
        if(!raw)continue;const number=phoneSchema.safeParse(`+${raw}`);if(!number.success||number.data===`+${client.info?.wid?.user}`)continue;
        if(!people.has(number.data))people.set(number.data,{phone:number.data,name:(record.name||number.data).slice(0,100)});
      }
      const value={contacts:[...people.values()].sort((a,b)=>a.name.localeCompare(b.name)),updatedAt:new Date().toISOString(),error:null};
      await db.setting.upsert({where:{key:`whatsapp-contacts:${this.sender.id}`},create:{key:`whatsapp-contacts:${this.sender.id}`,value},update:{value}});
      return value.contacts;
    }catch(error){
      const key=`whatsapp-contacts:${this.sender.id}`;const previous=await db.setting.findUnique({where:{key}});const value={...((previous?.value||{contacts:[],updatedAt:null}) as object),error:'Could not load contacts. Refresh contacts or add a phone number.'};
      await db.setting.upsert({where:{key},create:{key,value},update:{value}});throw error;
    }
  }
  async sendMessage(input:SendInput){
    const c=clients.get(this.sender.id);if(!c||await this.getConnectionStatus()!=='CONNECTED')throw new AppError(409,'WhatsApp is disconnected','DISCONNECTED');
    try{await c.pupPage!.evaluate(installWhatsAppCompatibility);}catch{throw new AppError(409,'WhatsApp is reconnecting; outgoing leads remain queued.','DISCONNECTED');}
    let recipient;try{recipient=await c.getNumberId(input.to.replace('+',''));}catch{throw new AppError(502,'Could not check this WhatsApp number.');}
    if(!recipient)throw new AppError(400,'This phone number is not registered on WhatsApp.');
    try{
      const message=await c.sendMessage(recipient._serialized,input.body,{sendSeen:false});
      const id=(message?.id as {_serialized?:string;$1?:string}|undefined)?._serialized||(message?.id as {$1?:string}|undefined)?.$1;
      if(!id)throw new UncertainDelivery('WhatsApp returned no message identifier.');
      return {id,status:'SUBMITTED' as const};
    }catch{throw new UncertainDelivery('WhatsApp submission outcome is uncertain. Check the linked account before resending.');}
  }
  async reconcileMessages(){
    const client=clients.get(this.sender.id);if(!client||await this.getConnectionStatus()!=='CONNECTED')return;
    const messages=await db.message.findMany({where:{senderId:this.sender.id,status:'FAILED',uncertain:true,lead:{sheet:{connectionType:{startsWith:'SIMPLE_'}}}},orderBy:{lastAttemptAt:'desc'},take:100});
    const groups=new Map<string,typeof messages>();
    for(const message of messages){
      if(!message.lastAttemptAt)continue;
      groups.set(message.recipient,[...(groups.get(message.recipient)||[]),message]);
    }
    for(const [recipient,attempts] of groups){
      // Read existing outgoing messages only. An exact body, recipient and
      // attempt-time match repairs the record; it never retries a send.
      const matches=await client.pupPage!.evaluate(async input=>{
        type Existing={id:{fromMe:boolean;_serialized?:string;$1?:string};body:string;t:number};
        type Chat={msgs:{getModelsArray:()=>Existing[]}};
        const app=window as unknown as {WWebJS:{getChat:(id:string,options:{getAsModel:false})=>Promise<Chat|null>};require:(name:string)=>{loadEarlierMsgs:(options:{chat:Chat})=>Promise<Existing[]>}};
        const chat=await app.WWebJS.getChat(input.recipient.replace('+','')+'@c.us',{getAsModel:false});
        if(!chat)return [];
        let loaded=chat.msgs.getModelsArray();
        const earliest=Math.min(...input.attempts.map(a=>a.attemptAt))-15000;
        // A restored tab initially holds only the last message of each chat.
        // Load bounded history before deciding an older attempt is unmatched.
        for(let page=0;page<10&&loaded.length<500&&(!loaded.length||Math.min(...loaded.map(m=>m.t*1000))>earliest);page++){
          try{
            const earlier=await app.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});
            if(!earlier?.length)break;
            loaded=[...earlier,...loaded];
          }catch{break;}
        }
        loaded=[...new Map(loaded.filter(m=>m.id._serialized||m.id.$1).map(m=>[m.id._serialized||m.id.$1,m])).values()];
        return input.attempts.flatMap(attempt=>{
          const found=loaded.filter(m=>m.id.fromMe&&m.body===attempt.body&&Math.abs(m.t*1000-attempt.attemptAt)<15000);
          return found.length===1?[{messageId:attempt.id,id:found[0].id._serialized||found[0].id.$1,time:found[0].t*1000}]:[];
        });
      },{recipient,attempts:attempts.map(m=>({id:m.id,body:decrypt(m.encryptedBody),attemptAt:m.lastAttemptAt!.getTime()}))}).catch(()=>[]);
      for(const match of matches){
        if(!match.id||await db.message.findUnique({where:{providerMessageId:match.id}}))continue;
        const message=attempts.find(attempt=>attempt.id===match.messageId);if(!message)continue;
        await databaseTransaction(async tx=>{
          const updated=await tx.message.updateMany({where:{id:message.id,status:'FAILED',uncertain:true},data:{status:'SUBMITTED',providerMessageId:match.id,submittedAt:new Date(match.time),uncertain:false,failedAt:null,failureReason:null}});
          if(updated.count)await queueDeliveryWriteback(tx,message,`reconciled:${message.attemptCount}`);
        });
      }
    }
  }
  async getMessageStatus(){return null;}
  async handleIncomingEvents(){}
}
export function whatsappProvider(sender:Sender):WhatsAppProvider {
  if(sender.provider==='DEMO'){if(!isDemo())throw new AppError(400,'Demo providers are disabled');return new DemoWhatsAppProvider(sender);}
  return sender.provider==='META'?new MetaWhatsAppProvider(sender):socketWhatsApp()?new SocketWhatsAppProvider(sender):nativeWhatsAppLogin()?new NativeWhatsAppProvider(sender):new WebWhatsAppProvider(sender);
}
