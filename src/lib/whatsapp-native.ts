import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer';
import type { Sender } from '@/generated/mongo';
import { db } from './db';
import { AppError } from './security';
import { registerWebClient, WebWhatsAppProvider, type SendInput, type WhatsAppProvider } from './whatsapp';
import { browserExecutablePath } from './browser-executable';

type Client=import('whatsapp-web.js').Client;
type Session={browser:Browser;page:Page;controller:AbortController;client?:Client;attempted:boolean;ready:boolean;background:boolean;lastQR?:string};
const sessions=new Map<string,Session>();
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export const backgroundWhatsApp=()=>!process.env.WHATSAPP_LOGIN_MODE||process.env.WHATSAPP_LOGIN_MODE==='background';
export const nativeWhatsAppLogin=()=>backgroundWhatsApp()||process.env.WHATSAPP_LOGIN_MODE==='native';

export function nativeProfilePath(id:string){
  if(!/^[\w-]+$/.test(id))throw new Error('Invalid WhatsApp account');
  return path.resolve(process.env.WHATSAPP_PROFILE_DIR||'data/whatsapp-web',id);
}

// The endpoint must match this dedicated profile's browser token, not just a reused port.
export async function nativeBrowserEndpoint(profile:string){
  try{
    const [port,token]=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
    if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[\w-]+$/.test(token))return null;
    const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500)});
    if(!response.ok)return null;
    const data=await response.json();const endpoint=new URL(data.webSocketDebuggerUrl);
    if(!['127.0.0.1','localhost'].includes(endpoint.hostname)||endpoint.protocol!=='ws:'||endpoint.port!==port||endpoint.pathname!==token)return null;
    return `ws://127.0.0.1:${port}${token}`;
  }catch{return null;}
}

async function windowState(session:Session,state:'normal'|'minimized'){
  if(session.background)return;
  const cdp=await session.page.createCDPSession();
  try{const {windowId}=await cdp.send('Browser.getWindowForTarget');await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:state}});if(state==='normal')await session.page.bringToFront();}
  finally{await cdp.detach();}
}

export function whatsappBrowserArguments(profile:string,background:boolean,interactive:boolean){
  return [`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-renderer-backgrounding',...(background?['--headless=new','--window-size=1365,900',...(process.platform==='linux'?['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']:[])]:[...(!interactive?['--start-minimized']:[]),'--new-window']),'https://web.whatsapp.com/'];
}

async function openBrowser(id:string,interactive:boolean):Promise<Session>{
  const profile=nativeProfilePath(id);await mkdir(profile,{recursive:true,mode:0o700});
  const background=backgroundWhatsApp();const puppeteer=await import('puppeteer');
  let endpoint=await nativeBrowserEndpoint(profile);
  const previousMode=await readFile(path.join(profile,'SmartLeadBrowserMode'),'utf8').catch(()=>null);
  if(endpoint&&(background&&previousMode!=='background'||!background&&previousMode==='background')){
    // Only this verified dedicated browser is restarted; its saved login survives.
    // Reattaching to an old visible browser would keep the window dependency.
    const previous=await puppeteer.connect({browserWSEndpoint:endpoint,defaultViewport:null});
    await previous.close();endpoint=null;await pause(500);
  }
  if(!endpoint){
    const executable=await browserExecutablePath(()=>puppeteer.executablePath());
    if(!executable)throw new AppError(503,'WhatsApp needs Chromium on the worker server. Install a Puppeteer browser or set CHROME_PATH to an installed browser.');
    // A normal installed browser loads the live original site. No automation user agent,
    // cached WhatsApp HTML, browser extensions, or messaging SDK runs during login.
    const child=spawn(executable,whatsappBrowserArguments(profile,background,interactive),{detached:true,stdio:'ignore',windowsHide:background});
    let launchFailed=false;child.once('error',()=>{launchFailed=true;});child.once('exit',()=>{launchFailed=true;});child.unref();
    for(let i=0;i<75&&!endpoint;i++){if(launchFailed)throw new AppError(503,'The WhatsApp browser could not start on this server. Check Chromium permissions and hosting resource limits.');await pause(400);endpoint=await nativeBrowserEndpoint(profile);}
    if(!endpoint)throw new AppError(503,'Could not connect to the WhatsApp browser. Check the worker server and try again.');
    await writeFile(path.join(profile,'SmartLeadBrowserMode'),background?'background':'native');
  }
  const browser=await puppeteer.connect({browserWSEndpoint:endpoint,defaultViewport:null});
  let page=(await browser.pages()).find(p=>p.url().startsWith('https://web.whatsapp.com/'));
  if(!page)page=await browser.waitForTarget(target=>target.type()==='page'&&target.url().startsWith('https://web.whatsapp.com/'),{timeout:10000}).then(target=>target.page()).catch(()=>null)||undefined;
  if(!page){page=await browser.newPage();await page.goto('https://web.whatsapp.com/',{waitUntil:'domcontentloaded',timeout:60000});}
  // Restoring a desktop profile can also restore its old WhatsApp tab. Keep
  // exactly one tab so it cannot compete with the background connection.
  for(const extra of await browser.pages())if(extra!==page&&extra.url().startsWith('https://web.whatsapp.com/'))await extra.close().catch(()=>{});
  // A restarted worker must replace exposed functions owned by its previous CDP
  // connection. Reload the original page while preserving the browser's login.
  if(await page.evaluate(()=>typeof (window as unknown as {WWebJS?:unknown}).WWebJS!=='undefined'))await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  const session:Session={browser,page,controller:new AbortController(),attempted:false,ready:false,background};
  if(interactive)await windowState(session,'normal').catch(()=>{});
  return session;
}

async function update(id:string,data:Record<string,unknown>){await db.sender.update({where:{id},data}).catch(()=>{});}

export class NativeWhatsAppProvider implements WhatsAppProvider {
  constructor(private sender:Sender){}
  async connect({interactive=true}:{interactive?:boolean}={}){
    const existing=sessions.get(this.sender.id);
    if(existing&&existing.browser.connected&&!existing.page.isClosed()){
      if(!existing.ready)existing.attempted=false;
      if(interactive)await windowState(existing,'normal').catch(()=>{});
      await update(this.sender.id,{status:existing.ready?'CONNECTED':existing.background&&existing.lastQR?'WAITING_QR':'WAITING_LOGIN',qrCode:existing.ready?null:existing.lastQR||null,lastError:null});
      return;
    }
    // Reserve the account in the worker before opening a window; queue jobs are serialized.
    await update(this.sender.id,{status:'CONNECTING',qrCode:null,lastError:null});
    try{
      const session=await openBrowser(this.sender.id,interactive);sessions.set(this.sender.id,session);
      session.browser.once('disconnected',()=>{
        if(sessions.get(this.sender.id)!==session||session.controller.signal.aborted)return;
        session.controller.abort();sessions.delete(this.sender.id);registerWebClient(this.sender.id,null);
        void update(this.sender.id,{status:'DISCONNECTED',qrCode:null,lastError:'WhatsApp Web was closed. Open it again to resume sending.'});
      });
      await update(this.sender.id,{status:'WAITING_LOGIN',qrCode:null,lastError:null});
      void this.watchLogin(session);
    }catch(error){await update(this.sender.id,{status:'ERROR',qrCode:null,lastError:error instanceof AppError?error.message:'Could not open WhatsApp Web. Please try again.'});throw error;}
  }

  private async watchLogin(session:Session){
    while(!session.controller.signal.aborted&&session.browser.connected&&!session.page.isClosed()){
      try{
        // Observe only the original page until the phone has approved login.
        const signedIn=await session.page.evaluate(()=>!!document.querySelector('#pane-side, [data-testid="chat-list"], [aria-label="Chat list"]'));
        if(signedIn&&!session.attempted&&!session.ready){session.attempted=true;await this.attachSender(session);}
        else if(!signedIn&&!session.client&&session.background)await this.captureQR(session);
        else if(!signedIn&&session.client){
          session.client.removeAllListeners();session.client=undefined;session.ready=false;session.attempted=false;registerWebClient(this.sender.id,null);
          await update(this.sender.id,{status:'WAITING_LOGIN',qrCode:null,lastError:null});
          await windowState(session,'normal').catch(()=>{});
          await session.page.reload({waitUntil:'domcontentloaded',timeout:60000});
        }
      }catch(error){
        if(session.controller.signal.aborted)break;
        console.error(JSON.stringify({event:'native_whatsapp_connection',message:error instanceof Error?error.message.slice(0,800):'Connection unavailable'}));
        if(session.attempted&&!session.ready){session.client?.removeAllListeners();session.client=undefined;registerWebClient(this.sender.id,null);await update(this.sender.id,{status:'ERROR',lastError:'WhatsApp is open, but automatic sending could not connect. Click Open WhatsApp Web to retry.'});await session.page.reload({waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});}
      }
      await pause(2000);
    }
    if(sessions.get(this.sender.id)===session&&!session.controller.signal.aborted){
      sessions.delete(this.sender.id);registerWebClient(this.sender.id,null);
      await session.browser.disconnect().catch(()=>{});
      await update(this.sender.id,{status:'DISCONNECTED',qrCode:null,lastError:'Open WhatsApp Web again to resume sending.'});
    }
  }

  private async captureQR(session:Session){
    const switched=await session.page.evaluate(()=>{
      const button=[...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(element=>element.innerText.trim()==='Use here');
      if(button){button.click();return true;}return false;
    });
    if(switched)return;
    // Display the live QR canvas drawn by the original website. No alternative
    // QR payload or messaging SDK is injected into the login page.
    const canvas=await session.page.$('[data-ref] canvas, canvas[aria-label*="QR" i]');
    if(!canvas)return;
    try{
      const qr=await canvas.evaluate(element=>(element as HTMLCanvasElement).toDataURL('image/png'));
      if(qr!==session.lastQR){session.lastQR=qr;await update(this.sender.id,{status:'WAITING_QR',qrCode:qr,lastError:null});}
    }finally{await canvas.dispose();}
  }

  private async attachSender(session:Session){
    await update(this.sender.id,{status:'CONNECTING',qrCode:null,lastError:null});
    const mod=await import('whatsapp-web.js');const {Client}=mod.default||mod;
    const client=new Client({userAgent:false as unknown as string,webVersionCache:{type:'none'}});
    session.client=client;
    // Attach to the SAME already signed-in page. Client.initialize() would open a
    // second login tab and override its browser identity, so it is not called here.
    Object.assign(client,{pupBrowser:session.browser,pupPage:session.page});
    client.on('ready',()=>{
      if(session.controller.signal.aborted||session.ready)return;
      session.ready=true;registerWebClient(this.sender.id,client);
      void update(this.sender.id,{status:'CONNECTED',qrCode:null,phone:client.info?.wid?.user?`+${client.info.wid.user}`:null,lastConnectedAt:new Date(),lastError:null}).then(async()=>{await windowState(session,'minimized').catch(()=>{});await new WebWhatsAppProvider(this.sender).reconcileMessages().catch(()=>{});await this.refreshContacts().catch(()=>{});});
    });
    client.on('disconnected',()=>{session.ready=false;registerWebClient(this.sender.id,null);void update(this.sender.id,{status:'DISCONNECTED',qrCode:null});});
    await (client as Client&{inject():Promise<void>}).inject();
    // Login completed before the SDK was attached; replay the already synced state.
    await session.page.evaluate(async()=>{
      const app=window as unknown as {require:(name:string)=>{Socket:{hasSynced:boolean}};onAppStateHasSyncedEvent?:()=>Promise<void>};
      if(app.require('WAWebSocketModel').Socket.hasSynced)await app.onAppStateHasSyncedEvent?.();
    });
  }

  async disconnect(){
    const session=sessions.get(this.sender.id);
    if(session){session.controller.abort();sessions.delete(this.sender.id);registerWebClient(this.sender.id,null);if(session.client)await session.client.logout().catch(()=>{});await session.browser.close().catch(()=>{});}
    await db.setting.deleteMany({where:{key:`whatsapp-contacts:${this.sender.id}`}});
    await update(this.sender.id,{status:'DISCONNECTED',qrCode:null,lastError:null});
  }
  async getConnectionStatus(){const session=sessions.get(this.sender.id);return session?.ready?new WebWhatsAppProvider(this.sender).getConnectionStatus():session?'WAITING_LOGIN':'DISCONNECTED';}
  async getQRCode(){return backgroundWhatsApp()?(await db.sender.findUniqueOrThrow({where:{id:this.sender.id}})).qrCode:null;}
  async refreshContacts(){return new WebWhatsAppProvider(this.sender).refreshContacts();}
  async sendMessage(input:SendInput){return new WebWhatsAppProvider(this.sender).sendMessage(input);}
  async getMessageStatus(){return null;}
  async handleIncomingEvents(){}
}

export async function detachNativeWhatsApp(){
  for(const [id,session] of sessions){session.controller.abort();session.client?.removeAllListeners();registerWebClient(id,null);await session.browser.disconnect().catch(()=>{});}
  sessions.clear();
}
