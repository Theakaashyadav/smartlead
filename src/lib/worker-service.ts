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

export function startWorkerService({closeDatabase=false}={}){
  const controller=new AbortController();
  const lease=new WorkerLease();
  let databaseReady=false;
  let fatalHeartbeat=false;
  let renewing:Promise<void>|undefined;
  const stopping=()=>controller.signal.aborted;
  const pause=(ms:number)=>sleep(ms,undefined,{signal:controller.signal}).catch(error=>{if(!stopping())throw error;});

  async function run(){
    await databaseHealth();databaseReady=true;
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
      if(!isDemo())await verifyWorkerBrowser();
      for(const sender of await db.sender.findMany({where:{provider:'WEB',status:{in:['CONNECTED','CONNECTING','WAITING_QR','WAITING_LOGIN']}}})){
        if(stopping())break;
        await whatsappProvider(sender).connect({interactive:false});
      }
      if(stopping())return;
      // Serialize with an in-flight renewal so both compare the latest lease value.
      clearInterval(heartbeatTimer);
      await renewing;
      if(stopping())return;
      if(!await lease.markReady())throw new Error('Worker lease lost');
      heartbeatTimer=setInterval(heartbeat,10000);
      await db.setting.deleteMany({where:{key:'simple:worker-error'}});
      console.log('SmartLead worker started. Automation jobs are stored in the application database.');
      while(!stopping()){
        try{
          await scheduleJobs(isDemo());
          await drainJobs(100,1500,undefined,()=>!stopping());
        }catch(error){
          if(databaseFailure(error))throw error;
          console.error(JSON.stringify({level:'error',event:'scheduler_error'}));
        }
        if(!stopping())await pause(3000);
      }
    }finally{clearInterval(heartbeatTimer);await renewing;}
  }

  const done=run().then(()=>{
    if(fatalHeartbeat)throw new Error('Worker ownership or database connection was lost');
    return {failed:false};
  }).catch(async error=>{
    const diagnostic=error instanceof WorkerBrowserError?{reason:error.reason,message:error.message}:databaseFailure(error)||{
      reason:'WORKER_START_FAILED',message:'The hosted worker stopped. Check the SmartLead runtime logs and database connection.',
    };
    console.error(JSON.stringify({event:'worker_failed',code:safeDatabaseErrorCode(error),...diagnostic}));
    if(databaseReady)await db.setting.upsert({where:{key:'simple:worker-error'},create:{key:'simple:worker-error',value:{...diagnostic,at:Date.now()}},update:{value:{...diagnostic,at:Date.now()}}}).catch(()=>{});
    return {failed:true};
  }).finally(async()=>{
    controller.abort();
    await detachNativeWhatsApp({closeBackground:process.env.NODE_ENV==='production'}).catch(()=>{});
    await closePublicSheetEditor().catch(()=>{});
    await lease.release().catch(()=>{});
    // An embedded worker shares database modules with the HTTP server.
    if(closeDatabase){await db.$disconnect().catch(()=>{});await closeMongoStorage().catch(()=>{});}
  });
  return {stop:()=>controller.abort(),done};
}
