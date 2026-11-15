import { db, type Transaction } from './db';
import { SUCCESSFUL_SEND_STATUSES } from './delivery';
import { AppError } from './security';
import { UncertainDelivery, whatsappProvider, type WhatsAppProvider } from './whatsapp';
import { leadSentNotificationMessage } from './simple-shared';
import { assertMessageSubmission } from './message-submission';

// Only messages included in a successful sheet write become eligible. Keeping
// this outbox on the original message leaves lead delivery counts unchanged.
export async function queueLeadSentNotifications(tx:Transaction,messageIds:string[],organizationId:string){
  if(!messageIds.length)return;
  const messages=await tx.message.findMany({where:{id:{in:messageIds},notificationStatus:'WAITING',status:{in:SUCCESSFUL_SEND_STATUSES},uncertain:false},select:{id:true}});
  for(const message of messages){
    const claimed=await tx.message.updateMany({where:{id:message.id,notificationStatus:'WAITING'},data:{notificationStatus:'QUEUED'}});
    if(!claimed.count)continue;
    await tx.message.updateMany({where:{id:message.id,executiveNotificationStatus:'WAITING'},data:{executiveNotificationStatus:'QUEUED'}});
    const key=`notify:lead-sent:${message.id}`;
    await tx.job.upsert({where:{key},create:{key,type:'NOTIFY',entityId:message.id,organizationId},update:{}});
  }
}

export async function dispatchLeadSentNotification(id:string,providerOverride?:WhatsAppProvider,beforeSend?:()=>Promise<void>){
  const message=await db.message.findUnique({where:{id},include:{sender:true,lead:{include:{sheet:true}}}});
  if(!message||message.notificationStatus!=='QUEUED')return;
  if(message.sender.organizationId!==message.lead.sheet.organizationId)throw new AppError(403,'Notification sender must belong to this organisation');
  if((!message.notificationPhone&&!message.executiveNotificationPhone)||!message.notificationName||message.lead.redactedAt||message.lead.sourceDeleted||message.uncertain||!SUCCESSFUL_SEND_STATUSES.includes(message.status)){
    await db.message.updateMany({where:{id,notificationStatus:'QUEUED'},data:{notificationStatus:'CANCELLED'}});
    await db.message.updateMany({where:{id,executiveNotificationStatus:{in:['WAITING','QUEUED']}},data:{executiveNotificationStatus:'CANCELLED'}});
    return;
  }
  if(message.executiveNotificationPhone&&(message.executiveNotificationUncertain||message.executiveNotificationStatus==='FAILED')){
    await db.message.updateMany({where:{id,notificationStatus:'QUEUED'},data:{notificationStatus:'FAILED',notificationUncertain:true,notificationFailureReason:'Executive notification acceptance is uncertain. Check the linked WhatsApp account before resending.'}});
    return;
  }
  if(message.sender.status!=='CONNECTED')throw new AppError(409,'Sender disconnected; sent notifications remain queued','DISCONNECTED');
  const claimed=await db.message.updateMany({where:{id,notificationStatus:'QUEUED'},data:{notificationStatus:'PROCESSING',notificationLastAttemptAt:new Date(),notificationAttemptCount:{increment:1}}});
  if(!claimed.count)return;
  const clean=(value:string)=>value.replace(/[\r\n]+/g,' ').trim();
  const leadName=clean(message.lead.customerName);
  const recipientName=clean(message.notificationName);
  let stage:'executive'|'owner'='owner';
  try{
    // Another dispatcher can finish the executive and requeue a rejected owner
    // between our initial read and claim. Only the state read under our claim
    // determines the next stage; an older read must never reset that receipt.
    const current=await db.message.findUnique({where:{id},select:{notificationStatus:true,executiveNotificationStatus:true,executiveNotificationUncertain:true}});
    if(!current||current.notificationStatus!=='PROCESSING')return;
    stage=message.executiveNotificationPhone&&!SUCCESSFUL_SEND_STATUSES.includes(current.executiveNotificationStatus||'')?'executive':'owner';
    if(stage==='executive'&&current.executiveNotificationUncertain)throw new UncertainDelivery('Executive notification acceptance is uncertain.');
    const provider=providerOverride||whatsappProvider(message.sender);
    if(stage==='executive'){
      const executiveClaim=await db.message.updateMany({where:{id,notificationStatus:'PROCESSING',executiveNotificationStatus:'QUEUED'},data:{executiveNotificationStatus:'PROCESSING',executiveNotificationLastAttemptAt:new Date(),executiveNotificationAttemptCount:{increment:1}}});
      if(!executiveClaim.count){
        if(!await db.message.findUnique({where:{id},select:{id:true}}))return;
        throw new AppError(409,'Executive notification is not ready for submission.');
      }
      await beforeSend?.();
      await assertMessageSubmission({messageId:id,purpose:'EXECUTIVE_LEAD_SENT_NOTIFICATION'},message.senderId);
      const result=await provider.sendMessage({
        to:message.executiveNotificationPhone!,
        body:leadSentNotificationMessage({leadName,recipientName}),
        parameters:[],messageId:message.id,purpose:'EXECUTIVE_LEAD_SENT_NOTIFICATION',
      });
      if(!result.id)throw new UncertainDelivery('Executive notification returned no submission identifier.');
      const saved=await db.message.updateMany({where:{id,notificationStatus:'PROCESSING',executiveNotificationStatus:'PROCESSING'},data:{executiveNotificationStatus:result.status,executiveNotificationProviderMessageId:result.id,executiveNotificationSubmittedAt:new Date(),executiveNotificationUncertain:false,executiveNotificationFailureReason:null}});
      if(!saved.count)return;
    }
    if(!message.notificationPhone){
      await db.message.updateMany({where:{id,notificationStatus:'PROCESSING'},data:{notificationStatus:'SUBMITTED',notificationSubmittedAt:new Date(),notificationUncertain:false,notificationFailureReason:null}});
      return;
    }
    // A recorded executive receipt survives owner retries, so the executive is
    // never sent the same notification again when the owner's send is rejected.
    stage='owner';
    await beforeSend?.();
    await assertMessageSubmission({messageId:id,purpose:'LEAD_SENT_NOTIFICATION'},message.senderId);
    const result=await provider.sendMessage({
      to:message.notificationPhone,
      body:leadSentNotificationMessage({leadName,recipientName,phone:message.lead.mobile,executiveUpdated:!!message.executiveNotificationPhone}),
      parameters:[],
      messageId:message.id,
      purpose:'LEAD_SENT_NOTIFICATION',
    });
    if(!result.id)throw new UncertainDelivery('Sent notification returned no submission identifier.');
    await db.message.updateMany({where:{id,notificationStatus:'PROCESSING'},data:{notificationStatus:result.status,notificationProviderMessageId:result.id,notificationSubmittedAt:new Date(),notificationUncertain:false,notificationFailureReason:null}});
  }catch(error){
    if(error instanceof AppError&&error.code==='WORK_CANCELLED'){
      await db.message.updateMany({where:{id,notificationStatus:'PROCESSING',executiveNotificationStatus:'PROCESSING'},data:{executiveNotificationStatus:'CANCELLED'}});
      await db.message.updateMany({where:{id,notificationStatus:'PROCESSING'},data:{notificationStatus:'CANCELLED',notificationFailureReason:null}});
      return;
    }
    const disconnected=error instanceof AppError&&error.code==='DISCONNECTED';
    const uncertain=error instanceof UncertainDelivery||!(error instanceof AppError);
    const failure=uncertain
      ? `${stage==='executive'?'Executive notification':'Sent notification'} acceptance is uncertain. Check the linked WhatsApp account before resending.`
      : disconnected?null:`${stage==='executive'?'Executive notification: ':''}${(error as Error).message}`;
    const saved=await db.message.updateMany({where:{id,notificationStatus:'PROCESSING'},data:{
      notificationStatus:uncertain?'FAILED':'QUEUED',notificationUncertain:uncertain,
      notificationFailureReason:failure,
      ...(stage==='executive'?{executiveNotificationStatus:uncertain?'FAILED':'QUEUED',executiveNotificationUncertain:uncertain,executiveNotificationFailureReason:failure}:{}),
    }});
    if(saved.count&&!uncertain)throw error;
  }
}
