import type { Assignment, Employee, FeedbackLink, FeedbackToken, Lead, Sheet } from '@/generated/mongo';
import { db, usingSQLite } from './db';
import { AppError, decrypt, encrypt, hash, verifyFeedbackSignature } from './security';
import { sheetProvider, sourceFingerprint, type SheetProvider, type SourceRow } from './google';
import { MANAGED, feedbackSchema } from './validation';
import { sheetAlreadySent, sheetSaysSent, SUCCESSFUL_SEND_STATUSES } from './delivery';
import { saveFeedback, transaction } from './engine';

export function temporaryLeadStorage(sheet:Pick<Sheet,'connectionType'>){
  return process.env.LEAD_STORAGE_MODE!=='permanent'&&sheet.connectionType!=='DEMO';
}

export function sheetOutputHash(values:Record<string,string>){
  return hash(JSON.stringify(Object.keys(MANAGED).sort().map(key=>[key,values[key]||''])));
}

// Customer details are cached in RAM only. The worker and web bundles share this
// bounded cache in an embedded deployment; a restart simply reads Sheets again.
type CachedSource={key:string;at:number;rows:SourceRow[]};
const globalCache=globalThis as unknown as {smartleadTemporarySources?:Map<string,CachedSource>};
const sources=globalCache.smartleadTemporarySources??=new Map<string,CachedSource>();
const cacheKey=(sheet:Sheet)=>JSON.stringify([sheet.credentialId,sheet.columnMapping,sheet.worksheetId]);
export function cacheTemporarySource(sheet:Sheet,rows:SourceRow[]){
  if(!temporaryLeadStorage(sheet))return;
  sources.delete(sheet.id);
  if(rows.length<=5000)sources.set(sheet.id,{key:cacheKey(sheet),at:Date.now(),rows});
  while(sources.size>16)sources.delete(sources.keys().next().value!);
}
export function invalidateTemporarySource(sheetId:string){sources.delete(sheetId);}

function validToken(token:string){return /^[\w-]{22}$/.test(token)||(token.length>=30&&token.length<=100&&verifyFeedbackSignature(token));}
export async function temporaryFeedbackLink(token:string){
  if(!validToken(token))throw new AppError(404,'Feedback link not found');
  const link=await db.feedbackLink.findUnique({where:{tokenHash:hash(token)}});
  if(link&&(link.revokedAt||link.expiresAt<=new Date()))throw new AppError(410,'This feedback link has expired or been revoked. Ask your manager for a new link.');
  return link;
}

export function sourceLeadData(sheet:Sheet,row:SourceRow){
  const values=row.values;const date=values.leadDate?new Date(values.leadDate):new Date();
  const snapshot={...Object.fromEntries(Object.keys(MANAGED).map(key=>[key,values[key]||''])),__publicFeedbackInitialized:'1',__sourceSent:sheetSaysSent(values.sentStatus)?'1':'0'};
  return {stableSourceId:row.stableId,sourceRow:row.row,metadataId:row.metadataId??null,sourceDeleted:false,
    sourceFingerprint:hash(JSON.stringify([sourceFingerprint(values),row.questions||[]])),sourceData:{questions:row.questions||[]},
    customerName:values.customerName||'Unnamed lead',mobile:values.mobile||'',email:values.email||null,project:values.project||sheet.project,
    location:values.location||null,budget:values.budget||null,source:values.source||null,requirement:values.requirement||null,
    leadDate:Number.isNaN(date.getTime())?new Date():date,managedSnapshot:snapshot};
}

type Access=FeedbackToken&{assignment:Assignment&{employee:Employee;lead:Lead&{sheet:Sheet}}};
export async function readTemporaryFeedback(link:FeedbackLink,observe=true):Promise<Access>{
  const [sheet,employee]=await Promise.all([db.sheet.findUnique({where:{id:link.sheetId}}),db.employee.findUnique({where:{id:link.employeeId}})]);
  if(!sheet||!employee?.active||employee.organizationId!==sheet.organizationId)throw new AppError(410,'This feedback assignment is no longer available.');
  const cached=sources.get(sheet.id);
  const rows=cached&&cached.key===cacheKey(sheet)&&Date.now()-cached.at<15000?cached.rows:await sheetProvider(sheet).read(sheet);
  if(rows!==cached?.rows)cacheTemporarySource(sheet,rows);
  const matches=rows.filter(row=>hash(row.stableId)===link.sourceHash);
  if(matches.length!==1)throw new AppError(409,'The original lead row is missing or duplicated. Ask your manager to check the sheet.','SYNC_CONFLICT');
  const row=matches[0];
  if(!sheetSaysSent(row.values.sentStatus))throw new AppError(410,'This lead has been reopened. Ask your manager for its current feedback link.');
  const outputHash=sheetOutputHash(row.values);
  if(observe&&outputHash!==link.outputHash){
    // An external sheet edit advances the small lookup version, so an old tab
    // cannot silently replace newer feedback. No cell content is kept here.
    await transaction(async tx=>{
      const changed=await tx.feedbackLink.updateMany({where:{id:link.id,version:link.version,outputHash:link.outputHash},data:{version:{increment:1},outputHash}});
      if(changed.count)await tx.feedbackLink.updateMany({where:{leadId:link.leadId,id:{not:link.id}},data:{version:link.version+1,outputHash}});
    });
    link=await db.feedbackLink.findUniqueOrThrow({where:{id:link.id}});
  }
  const data=sourceLeadData(sheet,row);
  const lead:Lead&{sheet:Sheet}={...data,id:link.leadId,sheetId:sheet.id,sheet,status:row.values.status||'New',interest:null,lastFeedback:row.values.feedback||null,
    nextFollowupAt:null,lastContactAt:null,version:link.version,writebackStatus:'SYNCED',redactedAt:null,createdAt:link.createdAt,updatedAt:link.createdAt};
  const assignment:Access['assignment']={id:link.assignmentId,leadId:link.leadId,employeeId:employee.id,assignedBy:null,isPrimary:true,active:true,generation:link.generation,assignedAt:link.createdAt,employee,lead};
  return {id:link.id,assignmentId:assignment.id,tokenHash:link.tokenHash,expiresAt:link.expiresAt,revokedAt:link.revokedAt,createdAt:link.createdAt,assignment};
}

// POST needs only the lookup and permanent connection settings. Slow Sheets
// reads, identity verification, and writes happen after the database commits.
export async function saveTemporaryFeedback(link:FeedbackLink,input:unknown){
  const data=feedbackSchema.parse(input);
  return transaction(async tx=>{
    const current=await tx.feedbackLink.findUnique({where:{id:link.id}});
    if(!current||current.revokedAt||current.expiresAt<=new Date())throw new AppError(410,'Feedback access expired');
    if(current.version!==data.version)throw new AppError(409,'Another update was saved. Refresh this lead before submitting again.','VERSION_CONFLICT');
    const [sheet,employee]=await Promise.all([tx.sheet.findUnique({where:{id:current.sheetId}}),tx.employee.findUnique({where:{id:current.employeeId}})]);
    if(!sheet||!employee?.active||employee.organizationId!==sheet.organizationId)throw new AppError(410,'This feedback assignment is no longer available.');
    await tx.lead.upsert({where:{id:current.leadId},create:{id:current.leadId,sheetId:sheet.id,stableSourceId:decrypt(current.encryptedSourceId),sourceRow:0,sourceFingerprint:'',
      customerName:'[Queued feedback]',mobile:'',project:sheet.project,version:data.version,managedSnapshot:{__temporaryFeedback:'1',__needsHydration:'1',__expectedOutputHash:current.outputHash,__publicFeedbackInitialized:'1',__sourceSent:'1',sentStatus:'Sent'}},update:{}});
    await tx.assignment.upsert({where:{id:current.assignmentId},create:{id:current.assignmentId,leadId:current.leadId,employeeId:employee.id,generation:current.generation},update:{}});
    await tx.feedbackToken.upsert({where:{id:current.id},create:{id:current.id,assignmentId:current.assignmentId,tokenHash:current.tokenHash,expiresAt:current.expiresAt},update:{}});
    const feedback=await saveFeedback(current.assignmentId,data,undefined,current.id,tx);
    const claimed=await tx.feedbackLink.updateMany({where:{id:current.id,version:data.version},data:{version:data.version+1}});
    if(!claimed.count)throw new AppError(409,'Another update was saved. Refresh this lead before submitting again.','VERSION_CONFLICT');
    await tx.feedbackLink.updateMany({where:{leadId:current.leadId,id:{not:current.id}},data:{version:data.version+1}});
    return feedback;
  });
}

export async function queueFeedbackSubmission(token:string,input:unknown){
  const saveLink=async(link:FeedbackLink)=>({feedback:await saveTemporaryFeedback(link,input),leadId:link.leadId});
  const link=await temporaryFeedbackLink(token);if(link)return saveLink(link);
  const legacy=await db.feedbackToken.findUnique({where:{tokenHash:hash(token)},include:{assignment:true}});
  if(!legacy){
    // Cleanup may have moved this token between the two database reads.
    const moved=await temporaryFeedbackLink(token);if(moved)return saveLink(moved);
    throw new AppError(410,'This feedback link has expired or been revoked. Ask your manager for a new link.');
  }
  if(legacy.revokedAt||legacy.expiresAt<=new Date()||!legacy.assignment.active||!legacy.assignment.isPrimary)throw new AppError(410,'Feedback access expired');
  try{return {feedback:await saveFeedback(legacy.assignmentId,input,undefined,legacy.id),leadId:legacy.assignment.leadId};}
  catch(error){
    if((error as {code?:string}).code==='P2025'){
      const moved=await temporaryFeedbackLink(token);if(moved)return saveLink(moved);
    }
    throw error;
  }
}

export async function hydrateTemporaryFeedback(leadId:string,provider?:SheetProvider){
  const lead=await db.lead.findUnique({where:{id:leadId},include:{sheet:true}});
  if(!lead||!temporaryLeadStorage(lead.sheet))return;
  const snapshot=(lead.managedSnapshot||{}) as Record<string,string>;
  if(snapshot.__needsHydration!=='1')return;
  const rows=await (provider||sheetProvider(lead.sheet)).read(lead.sheet);
  const matches=rows.filter(row=>row.stableId===lead.stableSourceId);
  if(matches.length!==1||!sheetSaysSent(matches[0].values.sentStatus))throw new AppError(409,'The original sent lead row is missing, duplicated, or reopened. Feedback remains queued.','SYNC_CONFLICT');
  if(sheetOutputHash(matches[0].values)!==snapshot.__expectedOutputHash)throw new AppError(409,'A managed sheet value changed after this feedback page was opened. Review the sheet before retrying.','SYNC_CONFLICT');
  const data=sourceLeadData(lead.sheet,matches[0]);
  await db.lead.update({where:{id:leadId},data:{...data,managedSnapshot:{...data.managedSnapshot,__temporaryFeedback:'1',__needsHydration:'0'}}});
}

export async function purgeCompletedLead(leadId:string,observed?:SourceRow){
  return transaction(async tx=>{
    const lead=await tx.lead.findUnique({where:{id:leadId},include:{sheet:true,messages:true,assignments:{include:{tokens:true}}}});
    if(!lead||!temporaryLeadStorage(lead.sheet)||lead.writebackStatus!=='SYNCED'||lead.redactedAt)return false;
    if(!sheetAlreadySent(lead.managedSnapshot))return false;
    if(observed&&(!sheetSaysSent(observed.values.sentStatus)||observed.values.status!==(lead.lastFeedback?lead.status:observed.values.status)||(lead.lastFeedback&&observed.values.feedback!==lead.lastFeedback)))return false;
    if(lead.messages.some(message=>message.uncertain||message.notificationUncertain||['QUEUED','PROCESSING','FAILED'].includes(message.status)||['WAITING','QUEUED','PROCESSING','FAILED'].includes(message.notificationStatus||'')))return false;
    const messageIds=lead.messages.map(message=>message.id);
    const jobs={OR:[{type:{in:['ASSIGN','WRITEBACK']},entityId:lead.id},{type:{in:['SEND','NOTIFY']},entityId:{in:messageIds}}]};
    if(await tx.job.findFirst({where:{...jobs,status:{in:['PENDING','PROCESSING','DEAD']}},select:{id:true}}))return false;
    const snapshot=(lead.managedSnapshot||{}) as Record<string,string>;
    for(const assignment of lead.assignments.filter(assignment=>assignment.active&&assignment.isPrimary))for(const token of assignment.tokens){
      if(token.revokedAt||token.expiresAt<=new Date())continue;
      const value={sheetId:lead.sheetId,employeeId:assignment.employeeId,leadId:lead.id,assignmentId:assignment.id,encryptedSourceId:encrypt(lead.stableSourceId),sourceHash:hash(lead.stableSourceId),generation:assignment.generation,version:lead.version,outputHash:sheetOutputHash(observed?.values||snapshot),expiresAt:token.expiresAt,revokedAt:null};
      await tx.feedbackLink.upsert({where:{id:token.id},create:{id:token.id,tokenHash:token.tokenHash,createdAt:token.createdAt,...value},update:value});
    }
    await tx.job.deleteMany({where:jobs});
    await tx.auditLog.deleteMany({where:{OR:[{entityType:'lead',entityId:lead.id},{entityType:'message',entityId:{in:messageIds}},{entityType:'assignment',entityId:{in:lead.assignments.map(assignment=>assignment.id)}}]}});
    await tx.feedbackToken.deleteMany({where:{assignmentId:{in:lead.assignments.map(assignment=>assignment.id)}}});
    await tx.feedback.deleteMany({where:{leadId:lead.id}});
    await tx.followup.deleteMany({where:{leadId:lead.id}});
    await tx.message.deleteMany({where:{leadId:lead.id}});
    await tx.assignment.deleteMany({where:{leadId:lead.id}});
    await tx.lead.delete({where:{id:lead.id}});
    invalidateTemporarySource(lead.sheetId);
    return true;
  });
}

export async function ensureTemporaryStorage(){
  if(usingSQLite)return;
  const {mongoDatabase}=await import('./mongo-storage');const database=await mongoDatabase();
  await database.collection('feedback_links').createIndexes([
    {key:{tokenHash:1},name:'tokenHash_unique',unique:true},
    {key:{sheetId:1,sourceHash:1}},{key:{leadId:1}},
    {key:{expiresAt:1},expireAfterSeconds:0,name:'feedback_link_expiry'},
  ]);
}

let lastSweep=0;
let sweepOffset=0;
export async function maintainTemporaryStorage(){
  if(process.env.LEAD_STORAGE_MODE==='permanent')return;
  if(Date.now()-lastSweep<60000)return;lastSweep=Date.now();
  // MongoDB's TTL index is a fallback. This also handles local SQLite and revoked links.
  await db.feedbackLink.deleteMany({where:{OR:[{expiresAt:{lte:new Date()}},{revokedAt:{not:null}}]}});
  // Completed history needs no Google call. A slow or unavailable sheet must
  // never prevent housekeeping from clearing already-finished database work.
  const cutoff=new Date(Date.now()-86400000);
  await db.syncLog.deleteMany({where:{sheet:{connectionType:{not:'DEMO'}},OR:[{status:'SUCCESS'},{createdAt:{lt:cutoff}}]}});
  await db.job.deleteMany({where:{status:'COMPLETED',OR:[{type:{in:['SYNC','ASSIGN','SEND','WRITEBACK','NOTIFY']}},{createdAt:{lt:cutoff}}]}});
  const sheets=await db.sheet.findMany({where:{connectionType:{not:'DEMO'},leads:{some:{writebackStatus:'SYNCED'}}},orderBy:{id:'asc'}});
  const sheet=sheets[sweepOffset++%Math.max(1,sheets.length)];
  if(sheet&&temporaryLeadStorage(sheet)){
    const rows=await sheetProvider(sheet).read(sheet);cacheTemporarySource(sheet,rows);
    const byId=new Map(rows.map(row=>[row.stableId,row]));
    const leads=await db.lead.findMany({where:{sheetId:sheet.id,writebackStatus:'SYNCED'},select:{id:true,stableSourceId:true}});
    for(const lead of leads){const row=byId.get(lead.stableSourceId);if(row&&sheetSaysSent(row.values.sentStatus))await purgeCompletedLead(lead.id,row);}
  }
}
