import type { Prisma, Sheet, Job } from '@/generated/mongo';
import { db, databaseTransaction } from './db';
import { appUrl } from './config';
import { AppError, audit, decrypt, encrypt, hash, opaqueToken, signedFeedbackToken, verifyFeedbackSignature } from './security';
import { sheetProvider, sourceFingerprint, type SheetProvider } from './google';
import { CLOSED, DEFAULT_TEMPLATE, phoneSchema, feedbackSchema, STATUSES, VARIABLES, MANAGED as MANAGED_FIELDS } from './validation';
import { chooseRecipients } from './distribution';
import { UncertainDelivery, whatsappProvider, type WhatsAppProvider } from './whatsapp';
import { simpleLeadMessage } from './simple-shared';
import { feedbackBaseURL } from './feedback-url';
import { organizationSettingKey } from './organizations';
import { sheetPollSeconds } from './automation-policy';
import { deliveryValues, queueDeliveryWriteback } from './delivery';

const sourceChecks = new Map<string, string>();
let nextSendAt = 0;

export async function enqueue(tx:Prisma.TransactionClient, type:string, entityId:string, key:string) {
  const entity=['CONNECT','DISCONNECT','CONTACTS'].includes(type)
    ? await tx.sender.findUniqueOrThrow({where:{id:entityId},select:{organizationId:true}})
    : type==='SYNC'
      ? await tx.sheet.findUniqueOrThrow({where:{id:entityId},select:{organizationId:true}})
      : type==='SEND'
        ? (await tx.message.findUniqueOrThrow({where:{id:entityId},select:{lead:{select:{sheet:{select:{organizationId:true}}}}}})).lead.sheet
        : (await tx.lead.findUniqueOrThrow({where:{id:entityId},select:{sheet:{select:{organizationId:true}}}})).sheet;
  return tx.job.upsert({where:{key},create:{key,type,entityId,organizationId:entity.organizationId},update:{}});
}
export async function transaction<T>(fn:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T> {
  for(let attempt=0;attempt<5;attempt++) {
    try{return await databaseTransaction(fn);}
    catch(error){const code=(error as {code?:string}).code;if(!['P2034','P1008','P2028'].includes(code||'')||attempt===4)throw error;await new Promise(r=>setTimeout(r,50*(attempt+1)));}
  }
  throw new Error('Transaction retry exhausted');
}
export async function synchronizeSheet(id:string, provider?:SheetProvider, options:{skipUnchanged?:boolean;refreshQueued?:boolean}={}) {
  const sheet=await db.sheet.findUniqueOrThrow({where:{id}});
  if(!options.skipUnchanged)await db.sheet.update({where:{id},data:{syncStatus:'SYNCING',lastSyncError:null}});
  try {
    const rows=await (provider||sheetProvider(sheet)).read(sheet);
    const contentHash=options.skipUnchanged?hash(JSON.stringify([sheet.createdAt,sheet.columnMapping,sheet.project,rows])):undefined;
    if(contentHash&&sourceChecks.get(id)===contentHash){
      await db.sheet.update({where:{id},data:{syncStatus:'SYNCED',lastSyncAt:new Date(),lastImported:0,lastSyncError:null}});
      return {imported:0,checked:rows.length};
    }
    if(options.skipUnchanged)await db.sheet.update({where:{id},data:{syncStatus:'SYNCING',lastSyncError:null}});
    // Fetch source identities in bounded batches rather than one round trip per row.
    const identities=rows.map(row=>row.stableId);
    const existingRows=[];
    for(let offset=0;offset<identities.length;offset+=500)existingRows.push(...await db.lead.findMany({
      where:{sheetId:id,stableSourceId:{in:identities.slice(offset,offset+500)}},
      select:{id:true,stableSourceId:true,redactedAt:true,sourceFingerprint:true,sourceRow:true,metadataId:true,sourceDeleted:true,managedSnapshot:true,status:true,lastFeedback:true,mobile:true},
    }));
    const existingById=new Map(existingRows.map(lead=>[lead.stableSourceId,lead]));
    const seen=new Set<string>();let imported=0;
    for(const row of rows) {
      if(seen.has(row.stableId))throw new AppError(409,'Duplicate source Lead IDs detected');
      seen.add(row.stableId);
      const parsed=phoneSchema.safeParse(row.values.mobile);
      const mobile=parsed.success?parsed.data:row.values.mobile;
      const fingerprint=hash(JSON.stringify([sourceFingerprint(row.values),row.questions||[]]));
      const existing=existingById.get(row.stableId);
      if(existing?.redactedAt)continue;
      const date=row.values.leadDate?new Date(row.values.leadDate):new Date();
      const data={customerName:row.values.customerName||'Unnamed lead',mobile,email:row.values.email||null,project:row.values.project||sheet.project,location:row.values.location||null,budget:row.values.budget||null,source:row.values.source||null,requirement:row.values.requirement||null,sourceRow:row.row,metadataId:row.metadataId||null,sourceFingerprint:fingerprint,sourceData:{questions:row.questions||[]},sourceDeleted:false};
      if(!existing) {
        await transaction(async tx=>{
          const publicSheet=sheet.connectionType==='SIMPLE_PUBLIC';
          const managedSnapshot={...Object.fromEntries(Object.keys(MANAGED_FIELDS).map(k=>[k,row.values[k]||''])),...(publicSheet?{__publicFeedbackInitialized:'1'}:{})};
          const lead=await tx.lead.upsert({where:{sheetId_stableSourceId:{sheetId:id,stableSourceId:row.stableId}},create:{...data,managedSnapshot,...(publicSheet?{status:row.values.status||'New',lastFeedback:row.values.feedback||null}:{}),sheetId:id,stableSourceId:row.stableId,leadDate:Number.isNaN(date.getTime())?new Date():date},update:{...data}});
          if(parsed.success) await enqueue(tx,'ASSIGN',lead.id,`assign:${lead.id}`);
          else await tx.syncLog.create({data:{sheetId:id,operation:'VALIDATION',status:'WARNING',details:`Row ${row.row} has an invalid phone number; automatic assignment paused.`}});
        });
        imported++;
      } else {
        const snapshot=(existing.managedSnapshot||{}) as Record<string,string>;
        // Adopt pre-existing public-sheet output values once when upgrading from
        // the read-only sender. Subsequent external edits remain conflicts.
        const initialize=sheet.connectionType==='SIMPLE_PUBLIC'&&!snapshot.__publicFeedbackInitialized;
        const hasFeedback=initialize?await db.feedback.count({where:{leadId:existing.id}}):0;
        const baseline=initialize?{managedSnapshot:{...snapshot,status:row.values.status||'',assignedEmployee:row.values.assignedEmployee||'',sentStatus:row.values.sentStatus||'',sharedTo:row.values.sharedTo||'',feedback:row.values.feedback||'',__publicFeedbackInitialized:'1'},...(!hasFeedback?{status:row.values.status||existing.status,lastFeedback:row.values.feedback||existing.lastFeedback}:{}),version:{increment:1}}:{};
        // A connector can fill a row in stages. Queue it when its phone first
        // becomes valid, retaining the stable Meta lead ID and job deduplication.
        if(parsed.success&&!phoneSchema.safeParse(existing.mobile).success){
          await transaction(async tx=>{
            await tx.lead.update({where:{id:existing.id},data:{...data,...baseline}});
            await enqueue(tx,'ASSIGN',existing.id,`assign:${existing.id}`);
          });
        }else if(initialize||existing.sourceFingerprint!==fingerprint||existing.sourceRow!==row.row||existing.metadataId!==(row.metadataId||null)||existing.sourceDeleted){
          await db.lead.update({where:{id:existing.id},data:{...(existing.sourceFingerprint!==fingerprint?data:{sourceRow:row.row,metadataId:row.metadataId||null,sourceDeleted:false}),...baseline}});
        }
      }
    }
    await db.lead.updateMany({where:{sheetId:id,sourceDeleted:false,stableSourceId:{notIn:[...seen]}},data:{sourceDeleted:true}});
    // The send path refreshes each queued body just before submission. Rebuilding
    // the whole outbox on every poll delays the first new lead and repeats work.
    if(options.refreshQueued!==false&&sheet.connectionType.startsWith('SIMPLE_'))await refreshSimpleQueuedMessages(id);
    await db.sheet.update({where:{id},data:{syncStatus:'SYNCED',lastSyncAt:new Date(),lastImported:imported,lastSyncError:null}});
    await db.syncLog.create({data:{sheetId:id,operation:'IMPORT',status:'SUCCESS',details:`Imported ${imported} new leads; checked ${rows.length} source rows.`}});
    if(contentHash)sourceChecks.set(id,contentHash);
    return {imported,checked:rows.length};
  } catch(error) {
    sourceChecks.delete(id);
    const message=error instanceof AppError?error.message:'Synchronization failed. Check credentials, source permissions, and API availability.';
    await db.sheet.update({where:{id},data:{syncStatus:'ERROR',lastSyncError:message}});
    await db.syncLog.create({data:{sheetId:id,operation:'IMPORT',status:'ERROR',details:message}});
    throw error;
  }
}
function templateBody(template:string, values:Record<string,string>) {
  return template.split('\n').map(line=>line.replace(/\{\{\s*(\w+)\s*\}\}/g,(_,v)=>values[v]||'')).filter(line=>!/^\*[^*]+:\*\s*$/.test(line)).join('\n');
}
export async function assignLead(leadId:string, employeeId?:string, userId?:string, reassign=false) {
  return transaction(async tx=>{
    const lead=await tx.lead.findUniqueOrThrow({where:{id:leadId},include:{sheet:{include:{rule:{include:{recipients:{orderBy:{position:'asc'},include:{employee:true}},sender:true}}}},assignments:{where:{active:true}}}});
    const rule=lead.sheet.rule;
    const simple=lead.sheet.connectionType.startsWith('SIMPLE_');
    if(!rule)throw new AppError(400,'Configure distribution settings first');
    if((rule.sender&&rule.sender.organizationId!==lead.sheet.organizationId)||rule.recipients.some(r=>r.employee.organizationId!==lead.sheet.organizationId))throw new AppError(403,'Sender and recipients must belong to this organisation');
    if(lead.sourceDeleted||lead.redactedAt)throw new AppError(409,'This lead is no longer available for assignment');
    if(lead.assignments.length && !reassign)return {assigned:false,reason:'Already assigned'};
    if(!rule.enabled && !employeeId)return {assigned:false,reason:'Distribution paused'};
    if(!employeeId && rule.mode==='MANUAL')return {assigned:false,reason:'Manual assignment required'};
    phoneSchema.parse(lead.mobile);
    const istDay=new Date(Date.now()+330*60000);istDay.setUTCHours(0,0,0,0);
    const day=new Date(istDay.getTime()-330*60000);
    const candidates=await Promise.all(rule.recipients.map(async r=>({id:r.employeeId,weight:r.weight,active:r.employee.active,capacity:simple?Number.MAX_SAFE_INTEGER:r.employee.capacity,dailyLimit:simple?Number.MAX_SAFE_INTEGER:r.employee.dailyLimit,daily:simple?0:await tx.assignment.count({where:{employeeId:r.employeeId,isPrimary:true,assignedAt:{gte:day}}}),pending:simple?0:await tx.assignment.count({where:{employeeId:r.employeeId,isPrimary:true,active:true,lead:{status:{notIn:CLOSED}}}})})));
    const chosen=employeeId?{owner:employeeId,notify:[employeeId],cursor:rule.cursor}:chooseRecipients(rule.mode,candidates,rule.cursor);
    if(!chosen)return {assigned:false,reason:'No employee has available capacity'};
    const owner=candidates.find(c=>c.id===chosen.owner);
    if(!owner?.active)throw new AppError(400,'Select an active, authorized recipient from this sheet');
    if(employeeId && (owner.daily>=owner.dailyLimit || owner.pending>=owner.capacity))throw new AppError(409,'The employee has reached their assignment limit');
    if(reassign) {
      await tx.feedbackToken.updateMany({where:{assignment:{leadId,active:true}},data:{revokedAt:new Date()}});
      await tx.assignment.updateMany({where:{leadId,active:true},data:{active:false}});
      await tx.message.updateMany({where:{leadId,status:'QUEUED'},data:{status:'CANCELLED',failureReason:'Lead reassigned before submission'}});
      await tx.followup.updateMany({where:{leadId,status:'PENDING'},data:{status:'CANCELLED'}});
    }
    const generation=(await tx.assignment.aggregate({where:{leadId},_max:{generation:true}}))._max.generation||0;
    for(const recipient of chosen.notify) {
      const employee=rule.recipients.find(r=>r.employeeId===recipient)!.employee;
      const assignment=await tx.assignment.create({data:{leadId,employeeId:recipient,assignedBy:userId,isPrimary:recipient===chosen.owner,generation:generation+1}});
      const raw=signedFeedbackToken();
      // Notification-only recipients get no editable bearer link.
      const feedbackLink=assignment.isPrimary?`${simple?await feedbackBaseURL(tx,true):appUrl()}/feedback/${raw}`:'The accountable lead owner will submit feedback.';
      if(assignment.isPrimary)await tx.feedbackToken.create({data:{assignmentId:assignment.id,tokenHash:hash(raw),expiresAt:new Date(Date.now()+30*86400000)}});
      if(rule.senderId) {
        const body=simple?simpleLeadMessage(lead,lead.sheet.name,feedbackLink):templateBody(rule.template||DEFAULT_TEMPLATE,{customer_name:lead.customerName,mobile_number:lead.mobile,project_name:lead.project,location:lead.location||'',budget:lead.budget||'',lead_source:lead.source||'',assigned_employee:rule.recipients.find(r=>r.employeeId===chosen.owner)!.employee.name,lead_date:lead.leadDate.toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),feedback_link:feedbackLink});
        const message=await tx.message.create({data:{idempotencyKey:`assignment:${assignment.id}`,leadId,assignmentId:assignment.id,senderId:rule.senderId,recipient:employee.phone,encryptedBody:encrypt(body)}});
        await enqueue(tx,'SEND',message.id,`send:${message.id}`);
      }
    }
    await tx.distributionRule.update({where:{id:rule.id},data:{cursor:chosen.cursor}});
    // Simple sheets record actual sends after provider acceptance, not a
    // recipient selection that may still be queued or fail later.
    const needsWriteback=!simple;
    const updated=await tx.lead.update({where:{id:leadId},data:{version:{increment:1},writebackStatus:needsWriteback?'PENDING':'SYNCED'}});
    if(needsWriteback)await enqueue(tx,'WRITEBACK',leadId,`writeback:assignment:${leadId}:${updated.version}`);
    await tx.auditLog.create({data:{userId,action:reassign?'REASSIGN':'ASSIGN',entityType:'lead',entityId:leadId}});
    return {assigned:true,owner:chosen.owner};
  });
}
export async function refreshSimpleQueuedMessages(sheetId:string,messageId?:string,requireOnline=false){
  const queued=await db.message.findMany({where:{...(messageId?{id:messageId}:{}),lead:{sheetId},status:'QUEUED',assignment:{active:true,isPrimary:true}},select:{id:true}});
  for(const message of queued)await transaction(async tx=>{
    const current=await tx.message.findUniqueOrThrow({where:{id:message.id},include:{assignment:true,lead:{include:{sheet:true}}}});
    if(current.status!=='QUEUED'||!current.assignment.active)return;
    let token=decrypt(current.encryptedBody).match(/\/feedback\/([\w.-]+)/)?.[1];
    const saved=token?await tx.feedbackToken.findUnique({where:{tokenHash:hash(token)}}):null;
    if(!saved||saved.assignmentId!==current.assignmentId||saved.revokedAt||saved.expiresAt<new Date()){
      token=signedFeedbackToken();await tx.feedbackToken.create({data:{assignmentId:current.assignmentId,tokenHash:hash(token),expiresAt:new Date(Date.now()+30*86400000)}});
    }
    const body=simpleLeadMessage(current.lead,current.lead.sheet.name,`${await feedbackBaseURL(tx,requireOnline)}/feedback/${token}`);
    if(body!==decrypt(current.encryptedBody))await tx.message.updateMany({where:{id:current.id,status:'QUEUED'},data:{encryptedBody:encrypt(body)}});
  });
}
export async function getFeedbackAccess(token:string) {
  if(token.length<30||token.length>100||!verifyFeedbackSignature(token))throw new AppError(404,'Feedback link not found');
  const record=await db.feedbackToken.findUnique({where:{tokenHash:hash(token)},include:{assignment:{include:{employee:true,lead:{include:{sheet:{select:{name:true,id:true,connectionType:true,worksheetName:true,organizationId:true}}}}}}}});
  if(!record||record.revokedAt||record.expiresAt<new Date()||!record.assignment.active||!record.assignment.isPrimary)throw new AppError(410,'This feedback link has expired or been revoked. Ask your manager for a new link.');
  return record;
}
export async function allowedStatuses(sheetId:string) {
  const sheet=await db.sheet.findUniqueOrThrow({where:{id:sheetId},select:{organizationId:true}});
  const setting=await db.setting.findFirst({where:{key:`statuses:${sheetId}`}})||await db.setting.findFirst({where:{key:organizationSettingKey(sheet.organizationId,'statuses')}});
  return setting?setting.value as string[]:STATUSES;
}
export async function saveFeedback(assignmentId:string,input:unknown,actorId?:string,tokenId?:string) {
  const data=feedbackSchema.parse(input);
  return transaction(async tx=>{
    const assignment=await tx.assignment.findUniqueOrThrow({where:{id:assignmentId},include:{lead:{include:{sheet:{select:{organizationId:true}}}}}});
    if(!assignment.active||!assignment.isPrimary)throw new AppError(403,'This assignment is no longer the accountable owner');
    if(tokenId){const token=await tx.feedbackToken.findUnique({where:{id:tokenId}});if(!token||token.assignmentId!==assignmentId||token.revokedAt||token.expiresAt<new Date())throw new AppError(410,'Feedback access expired');}
    const setting=await tx.setting.findUnique({where:{key:`statuses:${assignment.lead.sheetId}`}})||await tx.setting.findUnique({where:{key:organizationSettingKey(assignment.lead.sheet.organizationId,'statuses')}});
    if(data.status!==assignment.lead.status&&!(setting?.value as string[]||STATUSES).includes(data.status))throw new AppError(400,'Select a configured lead status');
    const followup=data.nextFollowupAt?new Date(data.nextFollowupAt):null;
    const updated=await tx.lead.updateMany({where:{id:assignment.leadId,version:data.version},data:{status:data.status,lastFeedback:data.remarks,interest:data.interest,nextFollowupAt:followup,lastContactAt:new Date(),version:{increment:1},writebackStatus:'PENDING'}});
    if(!updated.count)throw new AppError(409,'Another update was saved. Refresh this lead before submitting again.','VERSION_CONFLICT');
    const feedback=await tx.feedback.create({data:{leadId:assignment.leadId,assignmentId,employeeId:assignment.employeeId,status:data.status,remarks:data.remarks,interest:data.interest,callOutcome:data.callOutcome,contactMethod:data.contactMethod,siteVisitAt:data.siteVisitAt?new Date(data.siteVisitAt):null,expectedBudget:data.expectedBudget,nextFollowupAt:followup}});
    await tx.followup.updateMany({where:{leadId:assignment.leadId,status:'PENDING'},data:{status:'SUPERSEDED'}});
    if(followup)await tx.followup.create({data:{leadId:assignment.leadId,employeeId:assignment.employeeId,scheduledAt:followup,notes:data.remarks}});
    await enqueue(tx,'WRITEBACK',assignment.leadId,`writeback:feedback:${feedback.id}`);
    await tx.auditLog.create({data:{userId:actorId,action:'FEEDBACK_SUBMITTED',entityType:'lead',entityId:assignment.leadId}});
    return feedback;
  });
}
export async function writebackLead(id:string, provider?:SheetProvider,options:{deliveryOnly?:boolean}={}) {
  const startedAt=new Date();
  const lead=await db.lead.findUniqueOrThrow({where:{id},include:{sheet:true,assignments:{where:{active:true,isPrimary:true},include:{employee:true}},messages:{orderBy:{queuedAt:'desc'},include:{assignment:{include:{employee:true}}}}}});
  const owner=lead.assignments[0]?.employee;
  const message=lead.messages[0];
  if(lead.redactedAt)return;
  const delivery=deliveryValues(lead.messages);
  const simple=lead.sheet.connectionType.startsWith('SIMPLE_');
  // Delivery jobs also repair the latest submitted feedback. Otherwise an old
  // delivery job can mark a lead SYNCED while its feedback is still missing.
  const values:Record<string,string>=simple?{...delivery,...(lead.lastFeedback?{status:lead.status,feedback:lead.lastFeedback}: {})}:options.deliveryOnly?delivery:{assignedEmployee:owner?.name||'',assignedPhone:owner?.phone||'',status:lead.status,feedback:lead.lastFeedback||'',nextFollowupAt:lead.nextFollowupAt?.toISOString()||'',lastContactAt:lead.lastContactAt?.toISOString()||'',updatedAt:lead.updatedAt.toISOString(),updatedBy:owner?.name||'',...delivery,sentAt:message?.submittedAt?.toISOString()||'',deliveryStatus:message && ['SENT','DELIVERED','READ'].includes(message.status)?message.status:'Unconfirmed'};
  try {
    const observed=await (provider||sheetProvider(lead.sheet)).write(lead.sheet,lead.stableSourceId,lead.metadataId,values);
    const snapshot={...(lead.managedSnapshot as Record<string,string>||{}),...observed,...values,...(simple&&(observed||Object.hasOwn(values,'status'))?{__publicOutputV2:'1'}:{})};
    const updated=await db.lead.updateMany({where:{id,version:lead.version},data:{writebackStatus:'SYNCED',managedSnapshot:snapshot}});
    if(updated.count&&(simple||!options.deliveryOnly))await db.job.updateMany({where:{type:'WRITEBACK',entityId:id,status:{in:['PENDING','DEAD']},createdAt:{lte:startedAt}},data:{status:'COMPLETED',error:null,lockedAt:null,lockToken:null}});
    if(!updated.count){await db.lead.update({where:{id},data:{managedSnapshot:snapshot}});await enqueue(db,'WRITEBACK',id,`writeback:repair:${id}:${opaqueToken()}`);}
    await db.syncLog.create({data:{sheetId:lead.sheetId,operation:'WRITEBACK',status:'SUCCESS',details:`Managed fields synchronized for lead ${id}.`}});
  }catch(error){await db.lead.update({where:{id},data:{writebackStatus:'ERROR'}});await db.syncLog.create({data:{sheetId:lead.sheetId,operation:'WRITEBACK',status:'ERROR',details:error instanceof AppError?error.message:'Google writeback unavailable; feedback remains saved in the database.'}});throw error;}
}
export async function dispatchMessage(id:string, providerOverride?:WhatsAppProvider) {
  const message=await db.message.findUniqueOrThrow({where:{id},include:{sender:true,assignment:{include:{employee:true}},lead:{include:{sheet:{include:{rule:true}}}}}});
  if(message.status!=='QUEUED')return;
  if(message.sender.organizationId!==message.lead.sheet.organizationId||message.assignment.employee.organizationId!==message.lead.sheet.organizationId)throw new AppError(403,'Message connections must belong to this organisation');
  if(message.lead.sheet.connectionType.startsWith('SIMPLE_')&&!message.lead.sheet.rule?.enabled)throw new AppError(409,'Automatic sending is paused','PAUSED');
  if(!message.assignment.active||!message.assignment.employee.active){await db.message.update({where:{id},data:{status:'CANCELLED',failureReason:'Recipient or assignment is inactive'}});return;}
  if(message.sender.status!=='CONNECTED')throw new AppError(409,'Sender disconnected; outgoing jobs remain queued','DISCONNECTED');
  if(message.lead.sheet.connectionType.startsWith('SIMPLE_'))await refreshSimpleQueuedMessages(message.lead.sheetId,id,true);
  const claimed=await db.message.updateMany({where:{id,status:'QUEUED'},data:{status:'PROCESSING',attemptCount:{increment:1},lastAttemptAt:new Date()}});
  if(!claimed.count)return;
  const body=decrypt((await db.message.findUniqueOrThrow({where:{id}})).encryptedBody);
  const rule=message.lead.sheet.rule;
  // Meta approved template body parameter order is documented in README.
  const parameters=[message.lead.customerName,message.lead.mobile,message.lead.project,message.assignment.employee.name,body.match(/https?:\/\/\S+\/feedback\/\S+/)?.[0]||'Notification only'];
  try {
    const result=await (providerOverride||whatsappProvider(message.sender)).sendMessage({to:message.recipient,body,template:rule?.metaTemplate,language:rule?.metaLanguage,parameters,messageId:message.id});
    await transaction(async tx=>{await tx.message.update({where:{id},data:{status:result.status,providerMessageId:result.id,submittedAt:new Date(),uncertain:false,failureReason:null}});await queueDeliveryWriteback(tx,message,`submitted:${message.attemptCount+1}`);});
  } catch(error) {
    if(error instanceof AppError&&error.code==='DISCONNECTED'){
      await db.message.update({where:{id},data:{status:'QUEUED',failureReason:null}});throw error;
    }
    const uncertain=error instanceof UncertainDelivery || !(error instanceof AppError);
    await db.message.update({where:{id},data:{status:'FAILED',failedAt:new Date(),uncertain,failureReason:uncertain?'Acceptance is uncertain. Verify with the sender before any manual resend.':(error as Error).message}});
    // Provider rejections and uncertain outcomes require explicit review; no blind retry.
  }
}
export async function retryMessage(id:string,userId:string) {
  const message=await db.message.findUniqueOrThrow({where:{id}});
  if(message.status!=='FAILED'||message.uncertain)throw new AppError(409,'Only confirmed failures are eligible for retry. Uncertain outcomes require provider reconciliation.');
  await transaction(async tx=>{await tx.message.update({where:{id},data:{status:'QUEUED',failureReason:null,failedAt:null}});await enqueue(tx,'SEND',id,`send:${id}:retry:${message.attemptCount}`);await tx.auditLog.create({data:{userId,action:'RETRY_NOTIFICATION',entityType:'message',entityId:id}});});
}
export async function processJob(id:string, candidate?:Job) {
  const token=opaqueToken();
  const claimed=await db.job.updateMany({where:{id,status:'PENDING',runAt:{lte:new Date()}},data:{status:'PROCESSING',lockedAt:new Date(),lockToken:token}});
  if(!claimed.count)return false;
  const job=candidate||await db.job.findUniqueOrThrow({where:{id}});
  try {
    if(job.type==='SYNC')await synchronizeSheet(job.entityId,undefined,{skipUnchanged:true,refreshQueued:false});
    else if(job.type==='ASSIGN'){
      const result=await assignLead(job.entityId);
      if(!result.assigned && result.reason==='No employee has available capacity')throw new AppError(409,result.reason,'CAPACITY');
    }
    else if(job.type==='WRITEBACK')await writebackLead(job.entityId,undefined,{deliveryOnly:job.key.startsWith('writeback:delivery:')});
    else if(job.type==='SEND')await dispatchMessage(job.entityId);
    else if(job.type==='CONNECT'||job.type==='DISCONNECT'||job.type==='CONTACTS'){
      const sender=await db.sender.findUniqueOrThrow({where:{id:job.entityId}});
      const provider=whatsappProvider(sender);
      if(job.type==='CONNECT')await provider.connect();else if(job.type==='CONTACTS'&&'refreshContacts' in provider)await (provider as import('./whatsapp').WebWhatsAppProvider).refreshContacts();else if(job.type==='DISCONNECT')await provider.disconnect();
    }
    await db.job.updateMany({where:{id,lockToken:token},data:{status:'COMPLETED',lockedAt:null,lockToken:null,error:null}});
  }catch(error){
    const paused=error instanceof AppError && ['DISCONNECTED','CAPACITY','PAUSED','FEEDBACK_OFFLINE'].includes(error.code);
    const attempts=job.attempts+(paused?0:1);
    await db.job.updateMany({where:{id,lockToken:token},data:{status:attempts>=8?'DEAD':'PENDING',attempts,lockedAt:null,lockToken:null,error:error instanceof AppError?error.message:'Background operation failed; check integration configuration.',runAt:new Date(Date.now()+(paused?60000:Math.min(3600000,5000*2**attempts)))}});
  }
  return true;
}
export async function drainJobs(limit=50,sendDelay=0,organizationId?:string,shouldContinue=()=>true,types?:string[]) {
  let processed=0;
  for(let i=0;i<limit&&shouldContinue();i++) {
    const due={status:'PENDING',runAt:{lte:new Date()},...(organizationId?{organizationId}:{}),...(types?{type:{in:types}}:{})};
    const orderBy=[{createdAt:'asc' as const},{id:'asc' as const}];
    const controls=['CONNECT','DISCONNECT'].filter(type=>!types||types.includes(type));
    // Read independent priorities together so selection costs one network wait.
    // A newly created SEND overtakes remaining ASSIGN work in the same batch.
    const candidates=await Promise.all([
      controls.length?db.job.findFirst({where:{...due,type:{in:controls}},orderBy}):null,
      !types||types.includes('SEND')?db.job.findFirst({where:{...due,type:'SEND'},orderBy}):null,
      db.job.findFirst({where:due,orderBy}),
    ]);
    const job=candidates.find(candidate=>candidate!==null);
    if(!job||!shouldContinue())break;
    if(job.type==='SEND'&&sendDelay){
      const delay=nextSendAt-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
      if(!shouldContinue())break;
      nextSendAt=Date.now()+sendDelay;
    }
    if(await processJob(job.id,job))processed++;
  }
  return processed;
}
export async function scheduleJobs(simpleOnly=false,maintenance=true) {
  const sheets=await db.sheet.findMany({where:simpleOnly?{connectionType:{startsWith:'SIMPLE_'},rule:{enabled:true}}:undefined});
  const due=sheets.filter(sheet=>!sheet.lastSyncAt||Date.now()-sheet.lastSyncAt.getTime()>=sheetPollSeconds(sheet)*1000);
  const active=due.length?await db.job.findMany({where:{type:'SYNC',status:{in:['PENDING','PROCESSING']},entityId:{in:due.map(sheet=>sheet.id)}},select:{entityId:true}}):[];
  const activeIds=new Set(active.map(job=>job.entityId));
  for(const sheet of due)if(!activeIds.has(sheet.id)){
    const slot=Math.floor(Date.now()/(sheetPollSeconds(sheet)*1000));
    await enqueue(db,'SYNC',sheet.id,`sync:${sheet.id}:${slot}`);
  }
  if(!maintenance)return;
  // Jobs interrupted after possible submission are flagged, never automatically resent.
  const stale=new Date(Date.now()-5*60000);
  await db.message.updateMany({where:{status:'PROCESSING',lastAttemptAt:{lt:stale}},data:{status:'FAILED',uncertain:true,failureReason:'Worker stopped during submission; verify provider acceptance before resending.',failedAt:new Date()}});
  await db.job.updateMany({where:{status:'PROCESSING',lockedAt:{lt:stale}},data:{status:'PENDING',lockedAt:null,lockToken:null}});
  await db.authSession.deleteMany({where:{expiresAt:{lt:new Date()}}});
  await db.rateLimit.deleteMany({where:{expiresAt:{lt:new Date()}}});
}
