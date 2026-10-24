import { db, type Transaction } from './db';
import { SUCCESSFUL_SEND_STATUSES } from './delivery';
import { AppError } from './security';
import { UncertainDelivery, whatsappProvider, type WhatsAppProvider } from './whatsapp';

// Only messages included in a successful sheet write become eligible. Keeping
// this outbox on the original message leaves lead delivery counts unchanged.
export async function queueLeadSentNotifications(tx:Transaction,messageIds:string[],organizationId:string){
  if(!messageIds.length)return;
  const messages=await tx.message.findMany({where:{id:{in:messageIds},notificationStatus:'WAITING',status:{in:SUCCESSFUL_SEND_STATUSES},uncertain:false},select:{id:true}});
  for(const message of messages){
    const claimed=await tx.message.updateMany({where:{id:message.id,notificationStatus:'WAITING'},data:{notificationStatus:'QUEUED'}});
    if(!claimed.count)continue;
    const key=`notify:lead-sent:${message.id}`;
    await tx.job.upsert({where:{key},create:{key,type:'NOTIFY',entityId:message.id,organizationId},update:{}});
  }
}

export async function dispatchLeadSentNotification(id:string,providerOverride?:WhatsAppProvider){
  const message=await db.message.findUniqueOrThrow({where:{id},include:{sender:true,lead:{include:{sheet:true}}}});
  if(message.notificationStatus!=='QUEUED')return;
  if(message.sender.organizationId!==message.lead.sheet.organizationId)throw new AppError(403,'Notification sender must belong to this organisation');
  if(!message.notificationPhone||!message.notificationName||message.lead.redactedAt||message.lead.sourceDeleted||message.uncertain||!SUCCESSFUL_SEND_STATUSES.includes(message.status)){
    await db.message.updateMany({where:{id,notificationStatus:'QUEUED'},data:{notificationStatus:'CANCELLED'}});
    return;
  }
  if(message.sender.status!=='CONNECTED')throw new AppError(409,'Sender disconnected; sent notifications remain queued','DISCONNECTED');
  const claimed=await db.message.updateMany({where:{id,notificationStatus:'QUEUED'},data:{notificationStatus:'PROCESSING',notificationLastAttemptAt:new Date(),notificationAttemptCount:{increment:1}}});
  if(!claimed.count)return;
  try{
    const result=await (providerOverride||whatsappProvider(message.sender)).sendMessage({
      to:message.notificationPhone,
      body:`New Lead Sent to (${message.notificationName.replace(/[\r\n]+/g,' ').trim()})`,
      parameters:[],
      messageId:message.id,
      purpose:'LEAD_SENT_NOTIFICATION',
    });
    await db.message.update({where:{id},data:{notificationStatus:result.status,notificationProviderMessageId:result.id,notificationSubmittedAt:new Date(),notificationUncertain:false,notificationFailureReason:null}});
  }catch(error){
    const disconnected=error instanceof AppError&&error.code==='DISCONNECTED';
    const uncertain=error instanceof UncertainDelivery||!(error instanceof AppError);
    await db.message.update({where:{id},data:{
      notificationStatus:uncertain?'FAILED':'QUEUED',notificationUncertain:uncertain,
      notificationFailureReason:uncertain?'Sent notification acceptance is uncertain. Check the linked WhatsApp account before resending.':disconnected?null:(error as Error).message,
    }});
    if(!uncertain)throw error;
  }
}
