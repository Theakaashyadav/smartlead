import { db, usingSQLite, type Transaction } from './db';

export const SUCCESSFUL_SEND_STATUSES=['SUBMITTED','SENT','DELIVERED','READ'];
type DeliveryMessage={status:string;uncertain:boolean;assignment:{employee:{name:string}}};
export function deliveryValues(messages:DeliveryMessage[]){
  const sent=messages.filter(message=>!message.uncertain&&SUCCESSFUL_SEND_STATUSES.includes(message.status));
  return {sentStatus:sent.length?'Sent':'',sharedTo:[...new Set(sent.map(message=>message.assignment.employee.name))].join(', ')};
}

export async function deliveryBackfillLeads(sheetId:string){
  // MongoDB distinguishes a missing optional field from an explicit null.
  const notRedacted=usingSQLite?{redactedAt:null}:{OR:[{redactedAt:null},{redactedAt:{isSet:false}}]};
  return db.lead.findMany({where:{sheetId,sourceDeleted:false,...notRedacted,messages:{some:{status:{in:SUCCESSFUL_SEND_STATUSES},uncertain:false}}},select:{id:true,messages:{where:{status:{in:SUCCESSFUL_SEND_STATUSES},uncertain:false},orderBy:{queuedAt:'desc'},take:1,select:{id:true,leadId:true}}},orderBy:{sourceRow:'asc'}});
}

// A sheet update is a separate job. Its failure must never resend a message.
export async function queueDeliveryWriteback(tx:Transaction,message:{id:string;leadId:string},event:string){
  const key=`writeback:delivery:${message.id}:${event}`;
  const existing=await tx.job.findUnique({where:{key}});if(existing)return existing;
  const lead=await tx.lead.update({where:{id:message.leadId},data:{writebackStatus:'PENDING',version:{increment:1}},select:{sheet:{select:{organizationId:true}}}});
  return tx.job.upsert({where:{key},create:{key,organizationId:lead.sheet.organizationId,type:'WRITEBACK',entityId:message.leadId},update:{}});
}
