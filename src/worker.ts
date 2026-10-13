import './lib/config';
import { db, databaseHealth } from './lib/db';
import { isDemo } from './lib/config';
import { drainJobs, scheduleJobs } from './lib/engine';
import { whatsappProvider } from './lib/whatsapp';
import { detachNativeWhatsApp } from './lib/whatsapp-native';
import { closePublicSheetEditor } from './lib/public-sheet-editor';
import { closeMongoStorage } from './lib/mongo-storage';
import { WorkerLease } from './lib/worker-lease';
import { verifyWorkerBrowser, WorkerBrowserError } from './lib/worker-browser';
import { databaseFailure, safeDatabaseErrorCode } from './lib/database-errors';

let stopping=false;
const lease=new WorkerLease();
async function run() {
  await databaseHealth();
  if(!isDemo())await verifyWorkerBrowser();
  let waiting=false;
  while(!stopping&&!await lease.acquire()){
    if(!waiting){console.log(JSON.stringify({event:'worker_standby',message:'Another SmartLead worker owns the database. Waiting for it to stop.'}));waiting=true;}
    await new Promise(r=>setTimeout(r,3000));
  }
  if(stopping)return;
  let renewing:Promise<void>|undefined;
  const heartbeat=()=>{
    if(renewing||stopping)return;
    renewing=(async()=>{
      if(!await lease.renew())throw new Error('Worker lease lost');
    })().catch(()=>{
      console.error(JSON.stringify({event:'worker_heartbeat_failed',message:'Worker ownership or database connection was lost. Stopping for a supervised restart.'}));
      stopping=true;process.exitCode=1;
    }).finally(()=>{renewing=undefined;});
  };
  const heartbeatTimer=setInterval(heartbeat,10000);
  try{
    for(const sender of await db.sender.findMany({where:{provider:'WEB',status:{in:['CONNECTED','CONNECTING','WAITING_QR','WAITING_LOGIN']}}})){
      if(stopping)break;
      await whatsappProvider(sender).connect({interactive:false});
    }
    console.log('SmartLead worker started. Automation jobs are stored in the application database.');
    while(!stopping){
      try{
        await scheduleJobs(isDemo());
        await drainJobs(100,1500,undefined,()=>!stopping);
      }catch(error){
        if(databaseFailure(error))throw error;
        console.error(JSON.stringify({level:'error',event:'scheduler_error'}));
      }
      if(!stopping)await new Promise(r=>setTimeout(r,3000));
    }
  }finally{clearInterval(heartbeatTimer);await renewing;}
}
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
run().catch(error=>{
  const diagnostic=error instanceof WorkerBrowserError?{reason:error.reason,message:error.message}:databaseFailure(error);
  console.error(JSON.stringify({event:'worker_failed',code:safeDatabaseErrorCode(error),...(diagnostic||{message:'Worker failed. Verify the hosting database and environment configuration.'})}));
  process.exitCode=1;
}).finally(async()=>{
  stopping=true;
  await detachNativeWhatsApp({closeBackground:process.env.NODE_ENV==='production'}).catch(()=>{});
  await closePublicSheetEditor().catch(()=>{});
  await lease.release().catch(()=>{});
  await db.$disconnect().catch(()=>{});await closeMongoStorage().catch(()=>{});
});
