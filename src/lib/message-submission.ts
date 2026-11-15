import type { Prisma } from '@/generated/mongo';
import { db } from './db';
import { AppError } from './security';
import type { SendInput } from './whatsapp';

// The final provider handoff must still belong to a live processing message.
// Sheet-free test flows intentionally have no Message record.
export async function assertMessageSubmission(input:Pick<SendInput,'messageId'|'purpose'>,senderId:string){
  if(!input.messageId)return;
  const state:Prisma.MessageWhereInput=input.purpose==='EXECUTIVE_LEAD_SENT_NOTIFICATION'
    ? {notificationStatus:'PROCESSING',executiveNotificationStatus:'PROCESSING'}
    : input.purpose==='LEAD_SENT_NOTIFICATION'
      ? {notificationStatus:'PROCESSING'}
      : {status:'PROCESSING'};
  const pending=await db.message.findFirst({where:{id:input.messageId,senderId,...state,lead:{sourceDeleted:false,sheet:{syncStatus:{not:'DELETING'}}}},select:{id:true}});
  if(!pending)throw new AppError(409,'This message was cancelled or its sheet was deleted.','WORK_CANCELLED');
}
