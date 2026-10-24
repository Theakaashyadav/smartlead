import {z} from 'zod';
import type {Sheet,User} from '@/generated/mongo';
import {db} from './db';
import {AppError,audit,decrypt,encrypt,opaqueToken} from './security';
import {spreadsheetIdentity,SIMPLE_TEMPLATE} from './simple-shared';
import {simpleSourceRows} from './public-sheets';
import type {SheetProvider} from './google';
import {appsScriptCode} from './apps-script-code';
import {enqueue,transaction} from './engine';
import {SUCCESSFUL_SEND_STATUSES} from './delivery';
import {SIMPLE_POLL_SECONDS} from './automation-policy';

const protocol='smartlead-apps-script-v1';
const settingsSchema=z.object({token:z.string().min(32),spreadsheetId:z.string().regex(/^[\w-]+$/),gid:z.number().optional(),sheetId:z.string().optional(),endpoint:z.string().optional(),identityStyle:z.enum(['PUBLIC','RAW_ID']).optional()});
type Settings=z.infer<typeof settingsSchema>;
type Pending={userId:string;organizationId:string;createdAt:number;encrypted:string};
const inspectionSchema=z.object({title:z.string(),codeVersion:z.literal(2),canRead:z.literal(true),canWrite:z.literal(true),challenge:z.string(),tabs:z.array(z.object({id:z.number().int().nonnegative(),name:z.string(),headers:z.array(z.string())}))});
export function appsScriptEndpoint(value:string){
  let url:URL;try{url=new URL(value.trim());}catch{throw new AppError(400,'Paste the Apps Script web app URL ending in /exec.');}
  if(url.origin!=='https://script.google.com'||url.username||url.password||url.search||url.hash||!/^\/(?:macros\/s|a\/macros\/[\w.-]+\/s)\/[\w-]{20,}\/exec$/.test(url.pathname))throw new AppError(400,'Use the deployed Google Apps Script web app URL ending in /exec, not the editor or /dev link.');
  return url.toString();
}
export async function appsScriptRequest(settings:Settings,action:string,data:Record<string,unknown>={}){
  const endpoint=appsScriptEndpoint(settings.endpoint||'');
  const signal=AbortSignal.timeout(30000);
  let response:Response;
  try{
    response=await fetch(endpoint,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,action,spreadsheetId:settings.spreadsheetId,token:settings.token}),signal});
    // ContentService redirects its response to a one-time Google content URL.
    // The private key stays in the initial POST and is never forwarded.
    for(let i=0;response.status>=300&&response.status<400&&i<3;i++){
      const location=response.headers.get('location');const next=location?new URL(location,endpoint):null;
      if(!next||next.origin!=='https://script.googleusercontent.com'||next.username||next.password)throw new AppError(400,'Deploy the script as a Web app, Execute as Me, with access set to Anyone. Copy its /exec URL.','APPS_SCRIPT_DEPLOYMENT');
      response=await fetch(next,{redirect:'manual',cache:'no-store',signal});
    }
  }catch(error){if(error instanceof AppError)throw error;throw new AppError(502,'The Apps Script connection could not be reached. Check its deployment URL and try again.','APPS_SCRIPT_UNAVAILABLE');}
  if(!response.ok)throw new AppError(502,'Apps Script is unavailable. Check that the web app is deployed with access set to Anyone.','APPS_SCRIPT_DEPLOYMENT');
  const reader=response.body?.getReader();const decoder=new TextDecoder();let text='',size=0;
  if(!reader)throw new AppError(502,'The Apps Script deployment returned an empty response.','APPS_SCRIPT_DEPLOYMENT');
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>12000000){await reader.cancel();throw new AppError(413,'This sheet is too large for one Apps Script download.');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
  let result:any;try{result=JSON.parse(text);}catch{throw new AppError(400,'Apps Script did not return connection data. Use a Web app deployment, Execute as Me, with access set to Anyone.','APPS_SCRIPT_DEPLOYMENT');}
  if(result?.protocol!==protocol||result.spreadsheetId!==settings.spreadsheetId)throw new AppError(409,'This script belongs to a different sheet or uses an old connection code. Copy the code for this sheet and deploy a new version.','APPS_SCRIPT_SOURCE');
  if(result.ok!==true){
    if(result.code==='SCRIPT'){
      const stages:Record<string,string>={SOURCE:'locating the source row',LAYOUT:'preparing output columns',PERMISSION:'checking output permissions',SAVE:'saving the output cells',VERIFY:'verifying the saved cells'};
      const stage=stages[String(result.stage)];
      throw new AppError(409,`Apps Script failed${stage?' while '+stage:''}. Reconnect Apps Script, paste the latest code, then deploy a new version before checking the connection. If it still fails, check protection on the four output columns.`,'APPS_SCRIPT_UPGRADE');
    }
    if(result.code==='PROTECTED')throw new AppError(403,'The script account cannot edit the output cells. Remove protection from Sent Status, Shared To, Feedback and Remark, or deploy as a Google account allowed to edit those cells.','APPS_SCRIPT_PROTECTED');
    const errors:Record<string,[number,string,string]>={AUTH:[401,'The script connection key does not match. Paste the latest code, then deploy a new version.','APPS_SCRIPT_AUTH'],SOURCE:[409,'The original lead row is missing, duplicated or changed. No lead update was confirmed.','SYNC_CONFLICT'],CONFLICT:[409,'A managed sheet value was edited outside SmartLead. Review the conflict before retrying.','SYNC_CONFLICT'],TAB:[409,'The selected sheet tab no longer exists. Reconnect its Apps Script.','APPS_SCRIPT_SOURCE'],BUSY:[429,'The sheet script is busy. Its update will retry.','APPS_SCRIPT_BUSY'],VERIFY:[502,'Apps Script has not confirmed the saved lead fields. The update will retry.','APPS_SCRIPT_VERIFY'],SCRIPT:[403,'The script could not access or update this sheet. Check its authorization, protected cells and deployment permissions.','SHEET_READ_ONLY']};
    const [status,message,code]=errors[String(result.code)]||[502,'The script returned an invalid request response. Copy the current code and deploy a new version.','APPS_SCRIPT_DEPLOYMENT'];
    throw new AppError(status,message,code);
  }
  return result.data;
}
async function inspect(settings:Settings){
  const challenge=opaqueToken();const parsed=inspectionSchema.safeParse(await appsScriptRequest(settings,'check',{challenge}));
  if(!parsed.success||parsed.data.challenge!==challenge)throw new AppError(502,'Deploy the latest Apps Script code as a new version, then check the connection again. The deployed code did not confirm the current connection check.','APPS_SCRIPT_VERIFY');
  if(!parsed.data.tabs.length||settings.gid!==undefined&&!parsed.data.tabs.some(t=>t.id===settings.gid))throw new AppError(400,'The selected sheet tab was not found. Check the sheet link.');
  return {...parsed.data,spreadsheetId:settings.spreadsheetId,gid:settings.gid};
}
async function pendingSetup(user:User,id:string){
  if(!/^[\w-]{40,60}$/.test(id))throw new AppError(404,'Sheet setup not found. Start again.');
  const record=await db.setting.findUnique({where:{key:`apps-script:${id}`}});const pending=record?.value as unknown as Pending|undefined;
  if(!pending||pending.userId!==user.id||pending.organizationId!==user.organizationId)throw new AppError(404,'Sheet setup not found. Start again.');
  if(Date.now()-pending.createdAt>86400000)throw new AppError(410,'This script setup expired. Generate a new connection code.');
  return {record:record!,pending,settings:settingsSchema.parse(JSON.parse(decrypt(pending.encrypted)))};
}
export async function startAppsScriptSetup(user:User,input:{url?:string;sheetId?:string}){
  let settings:Settings;
  if(input.sheetId){
    const sheet=await db.sheet.findFirst({where:{id:input.sheetId,organizationId:user.organizationId,connectionType:{startsWith:'SIMPLE_'}}});
    if(!sheet)throw new AppError(404,'Sheet not found');
    settings={spreadsheetId:sheet.spreadsheetId,gid:sheet.worksheetId,sheetId:sheet.id,token:opaqueToken()};
    if(sheet.connectionType==='SIMPLE_APPS_SCRIPT'&&sheet.credentialId){
      const previous=await scriptSettings(sheet);
      settings={...previous,gid:sheet.worksheetId,sheetId:sheet.id};
    }
  }else{
    let identity:ReturnType<typeof spreadsheetIdentity>;try{identity=spreadsheetIdentity(input.url||'');}catch{throw new AppError(400,'Paste a valid Google Sheets link.');}
    settings={spreadsheetId:identity.id,gid:identity.gid,token:opaqueToken()};
  }
  const setupId=opaqueToken();const pending:Pending={userId:user.id,organizationId:user.organizationId,createdAt:Date.now(),encrypted:encrypt(JSON.stringify(settings))};
  await db.setting.create({data:{key:`apps-script:${setupId}`,value:{...pending}}});
  return {setupId,code:appsScriptCode(settings.spreadsheetId,settings.token),endpoint:settings.endpoint,sheetUrl:`https://docs.google.com/spreadsheets/d/${settings.spreadsheetId}/edit${settings.gid===undefined?'':`#gid=${settings.gid}`}`};
}
export async function checkAppsScriptSetup(user:User,id:string,endpoint:string){
  const {record,pending,settings}=await pendingSetup(user,id);settings.endpoint=appsScriptEndpoint(endpoint);
  const info=await inspect(settings);
  const updated=await db.setting.updateMany({where:{key:record.key,value:{equals:record.value!}},data:{value:{...pending,encrypted:encrypt(JSON.stringify(settings))}}});
  if(!updated.count)throw new AppError(409,'This setup changed. Check the connection again.');
  return {...info,scriptSetupId:id};
}
export async function connectAppsScriptSheet(user:User,input:{scriptSetupId:string;spreadsheetId:string;worksheetId:number;columnMapping:Record<string,string>}){
  const {record,settings}=await pendingSetup(user,input.scriptSetupId);
  if(!settings.endpoint||input.spreadsheetId!==settings.spreadsheetId)throw new AppError(400,'Check the Apps Script connection for this sheet first.');
  if(settings.sheetId&&settings.gid!==input.worksheetId)throw new AppError(409,'Select the original tab to reconnect this sheet.');
  const info=await inspect(settings);const tab=info.tabs.find(t=>t.id===input.worksheetId);
  if(!tab)throw new AppError(400,'Choose a sheet tab.');
  const outputCheck=await appsScriptRequest(settings,'prepare',{worksheetId:tab.id});
  if(outputCheck?.canWriteOutputs!==true)throw new AppError(502,'Apps Script did not confirm it can save the four output columns. Deploy the latest code and check again.','APPS_SCRIPT_VERIFY');
  const mapping=Object.fromEntries(Object.entries(input.columnMapping).filter(([key,value])=>['customerName','mobile','project','email','location','budget','source','requirement','leadDate','leadId'].includes(key)&&value));
  const sender=await db.sender.findFirst({where:{organizationId:user.organizationId,provider:'WEB'},orderBy:{createdAt:'asc'}});
  const result=await transaction(async tx=>{
    const existing=await tx.sheet.findFirst({where:{organizationId:user.organizationId,connectionType:{startsWith:'SIMPLE_'},spreadsheetId:settings.spreadsheetId,worksheetId:tab.id}});
    if(settings.sheetId&&existing?.id!==settings.sheetId)throw new AppError(409,'The original sheet connection changed. Start again.');
    if(!existing&&(!mapping.customerName||!mapping.mobile||Object.values(mapping).some(c=>!tab.headers.includes(c))||new Set(Object.values(mapping)).size!==Object.values(mapping).length))throw new AppError(400,'Choose different, valid name and phone columns.');
    let identityStyle:Settings['identityStyle']='PUBLIC';
    if(existing){
      if(existing.connectionType==='SIMPLE_APPS_SCRIPT'){
        const previous=await tx.googleCredential.findFirst({where:{id:existing.credentialId||'',organizationId:user.organizationId,type:'APPS_SCRIPT'}});
        if(previous)identityStyle=settingsSchema.parse(JSON.parse(decrypt(previous.encryptedValue))).identityStyle;
      }
      else if(!['SIMPLE_PUBLIC','SIMPLE_GOOGLE'].includes(existing.connectionType))identityStyle='RAW_ID';
    }
    const claimed=await tx.setting.deleteMany({where:{key:record.key,value:{equals:record.value!}}});
    if(!claimed.count)throw new AppError(409,'This script setup was already used. Reopen the sheet connection.');
    const credential=await tx.googleCredential.create({data:{organizationId:user.organizationId,label:`Apps Script · ${info.title}`,type:'APPS_SCRIPT',encryptedValue:encrypt(JSON.stringify({...settings,identityStyle}))}});
    if(existing){
      await tx.sheet.update({where:{id:existing.id},data:{connectionType:'SIMPLE_APPS_SCRIPT',credentialId:credential.id,worksheetName:tab.name,lastSyncError:null}});
      const leads=await tx.lead.findMany({where:{sheetId:existing.id,sourceDeleted:false,OR:[{feedback:{some:{}}},{messages:{some:{status:{in:SUCCESSFUL_SEND_STATUSES},uncertain:false}}}]},select:{id:true,redactedAt:true}});
      for(const lead of leads){if(lead.redactedAt)continue;await tx.lead.update({where:{id:lead.id},data:{writebackStatus:'PENDING',version:{increment:1}}});await enqueue(tx,'WRITEBACK',lead.id,`writeback:apps-script:${credential.id}:${lead.id}`);}
      return {id:existing.id,reauthorized:true};
    }
    const sheet=await tx.sheet.create({data:{organizationId:user.organizationId,name:info.title,project:info.title,spreadsheetId:settings.spreadsheetId,worksheetId:tab.id,worksheetName:tab.name,connectionType:'SIMPLE_APPS_SCRIPT',credentialId:credential.id,columnMapping:mapping,managedColumnsApproved:false,syncInterval:SIMPLE_POLL_SECONDS,rule:{create:{mode:'ROUND_ROBIN',enabled:false,senderId:sender?.id,template:SIMPLE_TEMPLATE}}}});
    return {id:sheet.id,reauthorized:false};
  });
  await audit(user.id,'CONNECT_APPS_SCRIPT','sheet',result.id);return result;
}
async function scriptSettings(sheet:Sheet){
  const credential=await db.googleCredential.findFirst({where:{id:sheet.credentialId||'',organizationId:sheet.organizationId,type:'APPS_SCRIPT'}});
  if(!credential)throw new AppError(401,'Reconnect this sheet using Apps Script to save its updates.','APPS_SCRIPT_AUTH');
  const settings=settingsSchema.parse(JSON.parse(decrypt(credential.encryptedValue)));
  if(settings.spreadsheetId!==sheet.spreadsheetId)throw new AppError(409,'This script connection belongs to a different spreadsheet.','APPS_SCRIPT_SOURCE');
  return settings;
}
function sourceRows(sheet:Sheet,rows:string[][],settings:Settings){
  const parsed=simpleSourceRows(sheet,rows);
  return settings.identityStyle==='RAW_ID'?parsed.map(row=>({...row,stableId:row.stableId.replace(/^public-id:/,''),values:{...row.values,leadId:row.stableId.replace(/^public-id:/,'')}})):parsed;
}
export class AppsScriptSheetsProvider implements SheetProvider{
  async read(sheet:Sheet){const settings=await scriptSettings(sheet);const data=await appsScriptRequest(settings,'read',{worksheetId:sheet.worksheetId});const rows=z.array(z.array(z.string())).parse(data?.rows);return sourceRows(sheet,rows,settings);}
  async write(sheet:Sheet,stableId:string,_metadataId:number|null,values:Record<string,string>){
    const lead=await db.lead.findUnique({where:{sheetId_stableSourceId:{sheetId:sheet.id,stableSourceId:stableId}}});
    if(!lead||lead.sourceDeleted||lead.redactedAt)throw new AppError(409,'The original lead is no longer available for sheet updates.');
    const settings=await scriptSettings(sheet);const raw=await appsScriptRequest(settings,'read',{worksheetId:sheet.worksheetId});const rows=z.array(z.array(z.string())).parse(raw?.rows);
    const source=sourceRows(sheet,rows,settings).filter(row=>row.stableId===stableId);
    if(source.length!==1)throw new AppError(409,'The original lead row is missing or duplicated.','SYNC_CONFLICT');
    const map=sheet.columnMapping as Record<string,string>;const headers=rows[0].map(h=>h.trim());
    const fields=map.leadId?['leadId']:['mobile',...(map.leadDate?['leadDate']:[])];
    const identity=fields.map(field=>({column:map[field],value:String(rows[source[0].row-1][headers.indexOf(map[field])]||'').trim()}));
    if(identity.some(cell=>!cell.column)||!identity[0]?.value)throw new AppError(409,'The source lead identity is missing.','SYNC_CONFLICT');
    const result=await appsScriptRequest(settings,'write',{worksheetId:sheet.worksheetId,stableId,metadataKey:`smartlead_script_${sheet.organizationId}_${sheet.worksheetId}`,identity,values,snapshot:lead.managedSnapshot||{}});
    const observed=z.record(z.string(),z.string()).parse(result?.values);
    if(!Object.entries(values).every(([field,value])=>observed[field]===value))throw new AppError(502,'Apps Script has not confirmed the saved lead fields. The update will retry.','APPS_SCRIPT_VERIFY');
    return observed;
  }
}
