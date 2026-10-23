import { z } from 'zod';
import { db, databaseTransaction, type Transaction } from './db';
import { AppError, hash, passwordHash } from './security';
import { phoneSchema, pinSchema } from './validation';

export const phoneCredentialsSchema=z.object({phone:phoneSchema,pin:pinSchema});

export async function recoverAdminPhoneLogin(input:unknown,userId?:string,transaction?:Transaction){
  const credentials=phoneCredentialsSchema.parse(input);
  const admins=await (transaction||db).user.findMany({where:{role:'SUPER_ADMIN',active:true,...(userId?{id:userId}:{})},select:{id:true},take:2});
  if(!admins.length)throw new AppError(404,'No active administrator found. Check the selected database and user ID.');
  if(admins.length!==1)throw new AppError(409,'Multiple administrators found. Run npm run admin:phone -- --list, then repeat with --user ID.');
  return setPhoneLogin(admins[0].id,credentials,transaction);
}

// Called only after authenticated re-verification or by the server administrator.
export async function setPhoneLogin(userId:string,input:unknown,transaction?:Transaction){
  const {phone,pin}=phoneCredentialsSchema.parse(input);
  const pinHash=passwordHash(pin);
  const apply=async(tx:Transaction)=>{
    const user=await tx.user.update({where:{id:userId,active:true},data:{phone,pinHash}});
    await tx.authSession.deleteMany({where:{userId}});
    await tx.resetToken.deleteMany({where:{userId}});
    await tx.rateLimit.deleteMany({where:{key:`login:phone:${hash(phone)}`}});
    await tx.auditLog.create({data:{userId,action:'SET_PHONE_LOGIN',entityType:'user',entityId:userId}});
    return user;
  };
  return transaction?apply(transaction):databaseTransaction(apply);
}
