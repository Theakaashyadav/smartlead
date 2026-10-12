import './lib/config';
import { db, databaseHealth } from './lib/db';
import { isDemo } from './lib/config';
import { drainJobs, scheduleJobs } from './lib/engine';
import { whatsappProvider } from './lib/whatsapp';
import { detachNativeWhatsApp } from './lib/whatsapp-native';
import { closePublicSheetEditor } from './lib/public-sheet-editor';
import { closeMongoStorage } from './lib/mongo-storage';

let stopping=false;
async function run() {
  await databaseHealth();
  const heartbeat=()=>db.setting.upsert({where:{key:'simple:worker'},create:{key:'simple:worker',value:{at:Date.now()}},update:{value:{at:Date.now()}}}).catch(()=>{});
  await heartbeat();const heartbeatTimer=setInterval(heartbeat,10000);heartbeatTimer.unref();
  for(const sender of await db.sender.findMany({where:{provider:'WEB',status:{in:['CONNECTED','CONNECTING','WAITING_QR','WAITING_LOGIN']}}}))await whatsappProvider(sender).connect({interactive:false});
  console.log('SmartLead worker started. Automation jobs are stored in the application database.');
  while(!stopping){
    try{
      await scheduleJobs(isDemo());
      await drainJobs(100,1500);
    }catch{console.error(JSON.stringify({level:'error',event:'scheduler_error'}));}
    if(!stopping)await new Promise(r=>setTimeout(r,3000));
  }
  clearInterval(heartbeatTimer);await detachNativeWhatsApp();await closePublicSheetEditor();await db.$disconnect();await closeMongoStorage();
}
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
run().catch(()=>{console.error('Worker startup failed. Verify database and environment configuration.');process.exitCode=1;});
