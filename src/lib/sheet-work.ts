import {db,type Transaction} from './db';
import {AppError} from './security';

export const cancelledSheetWork=()=>new AppError(409,'This sheet connection was deleted; its background work was cancelled.','WORK_CANCELLED');
export async function lockSheetWork(tx:Transaction,sheetId:string){
  // A genuine write holds MongoDB's document lock until this transaction ends.
  // Restore the counter in the same transaction so its public value is unchanged.
  const live=await tx.sheet.updateMany({where:{id:sheetId,syncStatus:{not:'DELETING'}},data:{lastImported:{increment:1}}});
  if(!live.count)throw cancelledSheetWork();
  await tx.sheet.updateMany({where:{id:sheetId},data:{lastImported:{decrement:1}}});
}
export async function assertSheetWork(sheetId:string,leadId?:string){
  const sheet=await db.sheet.findUnique({where:{id:sheetId},select:{syncStatus:true}});
  if(!sheet||sheet.syncStatus==='DELETING'||leadId&&!await db.lead.findFirst({where:{id:leadId,sheetId},select:{id:true}}))throw cancelledSheetWork();
}
