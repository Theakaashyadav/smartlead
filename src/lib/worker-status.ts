import { db } from './db';
import { appUrl } from './config';
import { AppError } from './security';

export function workerLeaseFresh(value:unknown,now=Date.now()){
  const at=value&&typeof value==='object'&&'at' in value?value.at:undefined;
  return typeof at==='number'&&Number.isFinite(at)&&at<=now+5000&&now-at<30000;
}

export function workerHeartbeatFresh(value:unknown,now=Date.now()){
  return workerLeaseFresh(value,now)&&!(value&&typeof value==='object'&&'ready' in value&&value.ready===false);
}

export function workerOfflineMessage(){
  let local=false;try{local=['localhost','127.0.0.1','[::1]'].includes(new URL(appUrl()).hostname);}catch{}
  return local?'WhatsApp connection service is offline. Open Start SmartLead.cmd on the computer running SmartLead, then try again.':'WhatsApp connection service is offline. Start the SmartLead worker on your hosting server, then try again.';
}

export async function requireWhatsAppWorker(){
  const worker=await db.setting.findUnique({where:{key:'simple:worker'}});
  if(!workerHeartbeatFresh(worker?.value))throw new AppError(503,workerOfflineMessage(),'WHATSAPP_WORKER_OFFLINE');
}
