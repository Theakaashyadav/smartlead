import './config';
import { setTimeout as sleep } from 'node:timers/promises';
import { db, databaseHealth } from './db';
import { isDemo } from './config';
import { drainJobs, scheduleJobs } from './engine';
import { whatsappProvider } from './whatsapp';
import { detachNativeWhatsApp } from './whatsapp-native';
import { closePublicSheetEditor } from './public-sheet-editor';
import { closeMongoStorage } from './mongo-storage';
import { WorkerLease } from './worker-lease';
import { verifyWorkerBrowser, WorkerBrowserError } from './worker-browser';
import { databaseFailure, safeDatabaseErrorCode } from './database-errors';
import { socketWhatsApp } from './whatsapp-mode';
import { closeSocketWhatsApp } from './whatsapp-socket';
import { SEND_INTERVAL_MS, WORKER_IDLE_MS } from './automation-policy';

export function startWorkerService({closeDatabase=false}={}){
  const controller=new AbortController();
  const lease=new WorkerLease();
  let databaseReady=false;
  let fatalHeartbeat=false;
  let renewing:Promise<void>|undefined;
  let stage='database';
  const stopping=()=>controller.signal.aborted;
  const pause=(ms:number)=>sleep(ms,undefined,{signal:controller.signal}).catch(error=>{if(!stopping())throw error;});

  async function run(){
    await databaseHealth();databaseReady=true;
    stage='lease';
    let waiting=false;
    while(!stopping()&&!await lease.acquire()){
      if(!waiting){console.log(JSON.stringify({event:'worker_standby',message:'Another SmartLead worker owns the database. Waiting for it to stop.'}));waiting=true;}
      await pause(3000);
    }
    if(stopping())return;
    const heartbeat=()=>{
      if(renewing||stopping())return;
      renewing=(async()=>{if(!await lease.renew())throw new Error('Worker lease lost');})().catch(()=>{
        fatalHeartbeat=true;controller.abort();
      }).finally(()=>{renewing=undefined;});
    };
    let heartbeatTimer=setInterval(heartbeat,10000);
    try{
      // Only the lease owner probes/opens browsers; standby web instances do not.
      stage='browser';
      if(!isDemo()&&!socketWhatsApp())await verifyWorkerBrowser();
      stage='restore';
      for(const sender of await db.sender.findMany({where:{provider:'WEB',status:{in:['CONNECTED','CONNECTING','WAITING_QR','WAITING_LOGIN']}}})){
        if(stopping())break;
        await whatsappProvider(sender).connect({interactive:false});
      }
      if(stopping())return;
      stage='readiness';
      // Serialize with an in-flight renewal so both compare the latest lease value.
      clearInterval(heartbeatTimer);
      await renewing;
      if(stopping())return;
      if(!await lease.markReady())throw new Error('Worker lease lost');
      heartbeatTimer=setInterval(heartbeat,10000);
      await db.setting.deleteMany({where:{key:'simple:worker-error'}});
      console.log('SmartLead worker started. Automation jobs are stored in the application database.');
      let maintainedAt=0;
      const loop=async(name:string,task:()=>Promise<unknown>,interval:number)=>{
        while(!stopping()){
          try{stage=name;await task();}
          catch(error){
            if(databaseFailure(error))throw error;
            console.error(JSON.stringify({level:'error',event:'scheduler_error',stage:name}));
          }
          if(!stopping())await pause(interval);
        }
      };
      // Sheet downloads and history/writeback work cannot hold up ready sends.
      const loops=[
        loop('send',()=>drainJobs(100,SEND_INTERVAL_MS,undefined,()=>!stopping(),['CONNECT','DISCONNECT','ASSIGN','SEND']),WORKER_IDLE_MS),
        loop('sheets',async()=>{
          const maintenance=Date.now()-maintainedAt>=60000;
          await scheduleJobs(isDemo(),maintenance);if(maintenance)maintainedAt=Date.now();
          await drainJobs(10,0,undefined,()=>!stopping(),['SYNC']);
        },WORKER_IDLE_MS),
        loop('writeback',()=>drainJobs(10,0,undefined,()=>!stopping(),['WRITEBACK','CONTACTS']),1000),
      ];
      try{await Promise.all(loops);}catch(error){controller.abort();await Promise.allSettled(loops);throw error;}
    }finally{clearInterval(heartbeatTimer);await renewing;}
  }

  const done=run().then(()=>{
    if(fatalHeartbeat)throw new Error('Worker ownership or database connection was lost');
    return {failed:false,reason:undefined as string|undefined};
  }).catch(async error=>{
    const browserError=error instanceof WorkerBrowserError||error&&typeof error==='object'&&typeof error.reason==='string'&&/^BROWSER_[A-Z_]+$/.test(error.reason);
    const diagnostic=browserError?{reason:error.reason as string,message:error.message as string}:databaseFailure(error)||{
      reason:'WORKER_START_FAILED',message:'The hosted worker stopped. Check the SmartLead runtime logs and database connection.',
    };
    const hint=typeof error?.message==='string'?error.message.match(/(?:[\w$]+\.)*[\w$]+ is not (?:a function|a constructor)|Worker (?:lease lost|heartbeat is invalid)/)?.[0]:undefined;
    const frames=typeof error?.stack==='string'?error.stack.split('\n').filter((line:string)=>/^\s+at /.test(line)).slice(0,3):undefined;
    console.error(JSON.stringify({event:'worker_failed',code:safeDatabaseErrorCode(error),stage,type:error?.name,hint,frames,...diagnostic}));
    if(databaseReady)await db.setting.upsert({where:{key:'simple:worker-error'},create:{key:'simple:worker-error',value:{...diagnostic,at:Date.now()}},update:{value:{...diagnostic,at:Date.now()}}}).catch(()=>{});
    return {failed:true,reason:diagnostic.reason};
  }).finally(async()=>{
    controller.abort();
    await closeSocketWhatsApp().catch(()=>{});
    await detachNativeWhatsApp({closeBackground:process.env.NODE_ENV==='production'}).catch(()=>{});
    await closePublicSheetEditor().catch(()=>{});
    await lease.release().catch(()=>{});
    // An embedded worker shares database modules with the HTTP server.
    if(closeDatabase){await db.$disconnect().catch(()=>{});await closeMongoStorage().catch(()=>{});}
  });
  return {stop:()=>controller.abort(),done};
}
