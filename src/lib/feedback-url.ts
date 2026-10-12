import { db } from './db';
import { appUrl } from './config';
import { AppError } from './security';
import type { Prisma } from '@/generated/mongo';

function publicOrigin(value:string){
  try{
    const url=new URL(value);
    const host=url.hostname;
    const privateHost=host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host==='[::1]'||host==='[::]'||/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    if(url.protocol!=='https:'||privateHost||!host.includes('.')||url.username||url.password)throw new Error('Not public');
    return url.origin;
  }catch{throw new AppError(503,'Feedback links need a public HTTPS address that recipients can open on their phones. Enable public feedback or configure PUBLIC_FEEDBACK_URL.','FEEDBACK_OFFLINE');}
}
function localFeedbackOrigin(value:unknown,app:URL){
  try{
    const url=new URL(String(value));
    if(!['localhost','127.0.0.1','[::1]'].includes(app.hostname)||url.protocol!=='http:'||url.hostname!=='smartlead.example.com'||url.port!==app.port||url.username||url.password)throw new Error('Invalid local alias');
    return url.origin;
  }catch{throw new AppError(503,'The local feedback address is invalid. Run Enable Local Feedback.cmd again.','FEEDBACK_OFFLINE');}
}
export async function feedbackBaseURL(client:Pick<Prisma.TransactionClient,'setting'>=db,requireOnline=false){
  if(process.env.PUBLIC_FEEDBACK_URL)return publicOrigin(process.env.PUBLIC_FEEDBACK_URL);
  const origin=new URL(appUrl());
  // A hosted domain or an explicit local test must not depend on an old relay.
  if(origin.protocol==='https:')return publicOrigin(origin.origin);
  const localAllowed=(await client.setting.findUnique({where:{key:'feedback:remoteRequired'}}))?.value===false;
  if(localAllowed){
    const local=await client.setting.findUnique({where:{key:'feedback:localOrigin'}});
    return local?localFeedbackOrigin(local.value,origin):origin.origin;
  }
  const relay=await client.setting.findUnique({where:{key:'feedback:public'}});
  if(relay){
    const value=relay.value as {url:string;at:number};
    if(requireOnline&&(!Number.isFinite(value.at)||Date.now()-value.at>45000))throw new AppError(503,'Public feedback links are offline. Start SmartLead to resume.','FEEDBACK_OFFLINE');
    return publicOrigin(value.url);
  }
  // Local-only URLs are an explicit development option, never a sending default.
  if(requireOnline)return publicOrigin(origin.origin);
  return origin.origin;
}
