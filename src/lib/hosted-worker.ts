import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startWorkerService } from './worker-service';

type HostedWorker={stopping:boolean;service?:ReturnType<typeof startWorkerService>;retry?:ReturnType<typeof setTimeout>;signalStop?:()=>void};
const runtime=globalThis as typeof globalThis&{smartleadHostedWorker?:HostedWorker};

export function hostedDataDirectory(cwd=process.cwd()){
  // Hostinger replaces hbuilds/versions; the domain directory survives publishing.
  const marker=`${path.sep}hbuilds${path.sep}`;
  const index=cwd.indexOf(marker);
  if(process.env.SMARTLEAD_DATA_DIR)return path.resolve(index>=0?cwd.slice(0,index):cwd,process.env.SMARTLEAD_DATA_DIR);
  return index>=0?path.join(cwd.slice(0,index),'smartlead-data'):path.resolve(cwd,'data');
}

export async function startHostedWorker(){
  if(runtime.smartleadHostedWorker)return;
  const state:HostedWorker={stopping:false};runtime.smartleadHostedWorker=state;
  try{
    const storage=hostedDataDirectory();
    const profileDirectory=(value:string|undefined,fallback:string)=>value?path.resolve(storage,value):path.join(storage,fallback);
    process.env.WHATSAPP_LOGIN_MODE=process.env.WHATSAPP_LOGIN_MODE==='headless'?'headless':'background';
    process.env.WHATSAPP_PROFILE_DIR=profileDirectory(process.env.WHATSAPP_PROFILE_DIR,'whatsapp-web');
    process.env.WHATSAPP_SESSION_DIR=profileDirectory(process.env.WHATSAPP_SESSION_DIR,'sessions');
    process.env.WHATSAPP_REMOTE_AUTH_DIR=profileDirectory(process.env.WHATSAPP_REMOTE_AUTH_DIR,'auth-archives');
    process.env.PUPPETEER_CACHE_DIR||=path.resolve('node_modules','.cache','puppeteer');
    for(const directory of [process.env.WHATSAPP_PROFILE_DIR,process.env.WHATSAPP_SESSION_DIR,process.env.WHATSAPP_REMOTE_AUTH_DIR])await mkdir(directory,{recursive:true,mode:0o700});
    let attempts=0;
    const launch=()=>{
      if(state.stopping)return;
      const started=Date.now();
      console.log(JSON.stringify({event:'hosted_worker_starting',manager:'nextjs'}));
      state.service=startWorkerService();
      void state.service.done.then(()=>{
        if(state.stopping)return;
        if(Date.now()-started>60000)attempts=0;
        const delay=Math.min(1000*2**Math.min(attempts++,5),30000);
        console.log(JSON.stringify({event:'hosted_worker_restarting',delayMs:delay}));
        state.retry=setTimeout(launch,delay);state.retry.unref();
      });
    };
    const stop=()=>{void stopHostedWorker();};state.signalStop=stop;
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    launch();
  }catch{
    delete runtime.smartleadHostedWorker;
    console.error(JSON.stringify({event:'hosted_worker_start_failed',reason:'WORKER_STORAGE',message:'Cannot prepare persistent WhatsApp storage. Set SMARTLEAD_DATA_DIR to a writable server directory.'}));
  }
}

export async function stopHostedWorker(){
  const state=runtime.smartleadHostedWorker;if(!state)return;
  state.stopping=true;clearTimeout(state.retry);state.service?.stop();
  await state.service?.done;
  if(state.signalStop){process.removeListener('SIGTERM',state.signalStop);process.removeListener('SIGINT',state.signalStop);}
  if(runtime.smartleadHostedWorker===state)delete runtime.smartleadHostedWorker;
}
