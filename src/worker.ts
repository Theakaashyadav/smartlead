import './lib/config';
import { Queue, Worker } from 'bullmq';
import { db } from './lib/db';
import { isDemo } from './lib/config';
import { drainJobs, processJob, scheduleJobs } from './lib/engine';
import { whatsappProvider } from './lib/whatsapp';
import { detachNativeWhatsApp } from './lib/whatsapp-native';
import { closePublicSheetEditor } from './lib/public-sheet-editor';

let stopping=false;
async function run() {
  const heartbeat=()=>db.setting.upsert({where:{key:'simple:worker'},create:{key:'simple:worker',value:{at:Date.now()}},update:{value:{at:Date.now()}}}).catch(()=>{});
  await heartbeat();const heartbeatTimer=setInterval(heartbeat,10000);heartbeatTimer.unref();
  for(const sender of await db.sender.findMany({where:{provider:'WEB',status:{in:['CONNECTED','CONNECTING','WAITING_QR','WAITING_LOGIN']}}}))await whatsappProvider(sender).connect({interactive:false});
  if(isDemo()){
    console.log('SmartLead local worker started. Live WhatsApp Web and connected Google Sheets are enabled.');
    while(!stopping){try{await scheduleJobs(true);await drainJobs(100,1500);}catch{console.error('Background connection error; retrying.');}await new Promise(r=>setTimeout(r,3000));}
    clearInterval(heartbeatTimer);await detachNativeWhatsApp();await closePublicSheetEditor();await db.$disconnect();
    return;
  }
  if(!process.env.REDIS_URL)throw new Error('REDIS_URL is required in production');
  const url=new URL(process.env.REDIS_URL);
  const connection={host:url.hostname,port:Number(url.port)||6379,username:url.username||undefined,password:url.password||undefined,maxRetriesPerRequest:null,...(url.protocol==='rediss:'?{tls:{}}:{})};
  const queue=new Queue('smartlead',{connection});
  // A dedicated single worker serializes sends; DB claims also prevent duplicate jobs.
  const worker=new Worker('smartlead',async job=>processJob(job.data.id),{connection,concurrency:1,limiter:{max:1,duration:1500}});
  worker.on('error',()=>console.error(JSON.stringify({level:'error',event:'queue_error'})));
  console.log('SmartLead production worker started.');
  while(!stopping){
    try{
      await scheduleJobs(true);
      const jobs=await db.job.findMany({where:{status:'PENDING',runAt:{lte:new Date()}},take:100,orderBy:[{createdAt:'asc'},{id:'asc'}]});
      for(const job of jobs)await queue.add(job.type,{id:job.id},{jobId:job.id,removeOnComplete:true,removeOnFail:100});
      for(const sender of await db.sender.findMany({where:{provider:'WEB',status:'CONNECTED'}})){
        const status=await whatsappProvider(sender).getConnectionStatus();
        if(status!=='CONNECTED')await db.sender.update({where:{id:sender.id},data:{status:'DISCONNECTED',lastError:'Session health check failed. Reconnect from WhatsApp Connections.'}});
      }
    }catch{console.error(JSON.stringify({level:'error',event:'scheduler_error'}));}
    await new Promise(r=>setTimeout(r,5000));
  }
  clearInterval(heartbeatTimer);await worker.close();await queue.close();await detachNativeWhatsApp();await closePublicSheetEditor();await db.$disconnect();
}
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
run().catch(()=>{console.error('Worker startup failed. Verify database, Redis, and environment configuration.');process.exitCode=1;});
