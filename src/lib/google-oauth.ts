import { cookies } from 'next/headers';
import { OAuth2Client } from 'google-auth-library';
import type { User } from '@/generated/mongo';
import { db } from './db';
import { appUrl } from './config';
import { AppError, audit, encrypt, hash, opaqueToken } from './security';
import { spreadsheetIdentity } from './simple-shared';
import { inspectSpreadsheet, verifyGoogleSheetEditor } from './google';
import { enqueue, transaction } from './engine';
import { SUCCESSFUL_SEND_STATUSES } from './delivery';

const scope='https://www.googleapis.com/auth/spreadsheets';
const stateCookie='google_oauth_state';
const popupCookie='google_oauth_popup';
type Pending={userId:string;organizationId:string;at:number;url?:string;sheetId?:string};
export function googleOAuthConfiguration(){
  const redirectUri=`${new URL(appUrl()).origin}/api/integrations/google/callback`;
  const missing=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'].filter(key=>!process.env[key]);
  const redirectValid=!process.env.GOOGLE_REDIRECT_URI||process.env.GOOGLE_REDIRECT_URI===redirectUri;
  return {oauthConfigured:!missing.length&&redirectValid,redirectUri,missing,redirectValid};
}
function oauthClient(){
  const config=googleOAuthConfiguration();
  if(!config.oauthConfigured)throw new AppError(503,'Google sign-in has not been enabled for SmartLead yet. The app owner needs to activate the Google connection.','GOOGLE_OAUTH_NOT_CONFIGURED');
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,config.redirectUri);
}
export async function googleAuthorizationUsesPopup(){return (await cookies()).get(popupCookie)?.value==='1';}
export async function startGoogleAuthorization(user:User,input:{url?:string;sheetId?:string;popup?:boolean}={}){
  const oauth=oauthClient();
  const pending:Pending={userId:user.id,organizationId:user.organizationId,at:Date.now()};
  if(input.sheetId){
    const sheet=await db.sheet.findFirst({where:{id:input.sheetId,organizationId:user.organizationId,connectionType:{startsWith:'SIMPLE_'}}});
    if(!sheet)throw new AppError(404,'Sheet not found');
    pending.sheetId=sheet.id;pending.url=`https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit#gid=${sheet.worksheetId}`;
  }else if(input.url){
    let identity:ReturnType<typeof spreadsheetIdentity>;
    try{identity=spreadsheetIdentity(input.url);}catch{throw new AppError(400,'Paste a valid Google Sheets link.');}
    pending.url=`https://docs.google.com/spreadsheets/d/${identity.id}/edit${identity.gid===undefined?'':`#gid=${identity.gid}`}`;
  }
  const state=opaqueToken();const fingerprint=hash(`${user.id}:${user.organizationId}:${state}`);
  await db.setting.create({data:{key:`google-oauth:${hash(state)}`,value:pending}});
  const jar=await cookies();const options={httpOnly:true,sameSite:'lax' as const,secure:appUrl().startsWith('https://'),path:'/',maxAge:600};
  jar.set(stateCookie,fingerprint,options);
  if(input.popup)jar.set(popupCookie,'1',options);else jar.delete(popupCookie);
  return {url:oauth.generateAuthUrl({access_type:'offline',prompt:'consent select_account',scope:[scope],include_granted_scopes:true,state})};
}
export async function attachAuthorizedSheet(user:User,sheetId:string,credentialId:string,worksheetName?:string){
  return transaction(async tx=>{
    const sheet=await tx.sheet.findFirst({where:{id:sheetId,organizationId:user.organizationId,connectionType:{startsWith:'SIMPLE_'}}});
    if(!sheet)throw new AppError(404,'The original sheet connection no longer exists.');
    if(!await tx.googleCredential.findFirst({where:{id:credentialId,organizationId:user.organizationId}}))throw new AppError(403,'Google account is not connected to this organisation.');
    const connectionType=['SIMPLE_PUBLIC','SIMPLE_GOOGLE'].includes(sheet.connectionType)?'SIMPLE_GOOGLE':sheet.connectionType;
    await tx.sheet.update({where:{id:sheet.id},data:{connectionType,credentialId,...(worksheetName?{worksheetName}:{}),lastSyncError:null}});
    const leads=await tx.lead.findMany({where:{sheetId:sheet.id,sourceDeleted:false,OR:[{feedback:{some:{}}},{messages:{some:{status:{in:SUCCESSFUL_SEND_STATUSES},uncertain:false}}}]},select:{id:true,redactedAt:true}});
    for(const lead of leads){
      if(lead.redactedAt)continue;
      await tx.lead.update({where:{id:lead.id},data:{writebackStatus:'PENDING',version:{increment:1}}});
      await enqueue(tx,'WRITEBACK',lead.id,`writeback:google-authorized:${credentialId}:${lead.id}`);
    }
    return sheet.id;
  });
}
export async function finishGoogleAuthorization(user:User,params:URLSearchParams){
  const jar=await cookies();const expected=jar.get(stateCookie)?.value;jar.delete(stateCookie);jar.delete(popupCookie);
  const state=params.get('state')||'';const key=`google-oauth:${hash(state)}`;
  const saved=await db.setting.findUnique({where:{key}});const pending=saved?.value as Pending|undefined;
  if(!expected||expected!==hash(`${user.id}:${user.organizationId}:${state}`)||!pending||pending.userId!==user.id||pending.organizationId!==user.organizationId||Date.now()-pending.at>600000)throw new AppError(403,'Google authorization expired. Start again.','GOOGLE_OAUTH_STATE');
  const claimed=await db.setting.deleteMany({where:{key,value:{equals:saved!.value!}}});
  if(!claimed.count)throw new AppError(403,'Google authorization was already used. Start again.','GOOGLE_OAUTH_STATE');
  if(params.get('error'))throw new AppError(400,'Google authorization was cancelled. Your existing sheet connection is unchanged.','GOOGLE_AUTH_DENIED');
  const code=params.get('code');if(!code)throw new AppError(400,'Google did not return an authorization code. Try again.');
  const oauth=oauthClient();let tokens;
  try{({tokens}=await oauth.getToken(code));}catch{throw new AppError(400,'Google authorization could not be completed. Start again.');}
  if(!tokens.refresh_token)throw new AppError(400,'Google did not grant background access. Authorize again and allow the requested access.');
  if(tokens.scope&&!tokens.scope.split(' ').includes(scope))throw new AppError(403,'Allow Google Sheets editing access on the Google consent screen.');
  const credential=await db.googleCredential.create({data:{organizationId:user.organizationId,label:`Google account · ${new Date().toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})}`,type:'OAUTH',encryptedValue:encrypt(JSON.stringify(tokens))}});
  const destination=new URL('/sheets',appUrl());destination.searchParams.set('google','connected');
  try{
    if(pending.url){
      const identity=spreadsheetIdentity(pending.url);
      const info=await inspectSpreadsheet(identity.id,credential.id,user.organizationId);
      if(identity.gid!==undefined&&!info.tabs.some((tab:{id:number})=>tab.id===identity.gid))throw new AppError(400,'The selected sheet tab no longer exists.');
      await verifyGoogleSheetEditor(identity.id,credential.id,user.organizationId);
      if(pending.sheetId){
        const existing=await db.sheet.findFirst({where:{id:pending.sheetId,organizationId:user.organizationId,spreadsheetId:identity.id,worksheetId:identity.gid}});
        if(!existing)throw new AppError(409,'The original sheet connection changed. Start authorization again.');
        await attachAuthorizedSheet(user,existing.id,credential.id,info.tabs.find((tab:{id:number})=>tab.id===existing.worksheetId)?.name);
      }else{
        destination.searchParams.set('credential',credential.id);destination.searchParams.set('sheet',pending.url);
      }
    }
    await audit(user.id,'CONNECT_GOOGLE','integration');
    return destination.toString();
  }catch(error){await db.googleCredential.deleteMany({where:{id:credential.id,sheets:{none:{}}}});throw error;}
}
