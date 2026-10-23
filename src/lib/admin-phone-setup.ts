import { ZodError } from 'zod';
import { db, databaseTransaction, usingSQLite } from './db';
import { AppError, hash } from './security';
import { phoneSchema, pinSchema } from './validation';
import { recoverAdminPhoneLogin } from './phone-login';
import { databaseFailure } from './database-errors';

type Environment=Record<string,string|undefined>;
type SetupResult={status:'disabled'|'already-complete'}|{status:'complete';userId:string;phone:string;twoFactorEnabled:boolean};
export const adminPhoneSetupKey=(phone:string)=>`admin-phone:setup:${hash(phone)}`;

export async function setupAdminPhoneOnce(env:Environment=process.env):Promise<SetupResult>{
  if(env.ADMIN_PHONE_SETUP!=='true')return {status:'disabled'};
  const phone=phoneSchema.parse(env.ADMIN_PHONE);
  if(!usingSQLite){
    const {mongoDatabase,initializeMongoDatabase}=await import('./mongo-storage');
    await initializeMongoDatabase(await mongoDatabase());
  }
  const key=adminPhoneSetupKey(phone);
  for(let attempt=0;attempt<3;attempt++){
    try{
      return await databaseTransaction(async tx=>{
        if(await tx.setting.findUnique({where:{key}}))return {status:'already-complete'} as const;
        const pin=pinSchema.parse(env.ADMIN_PIN?.trim());
        const user=await recoverAdminPhoneLogin({phone,pin},env.ADMIN_USER_ID?.trim()||undefined,tx);
        await tx.setting.create({data:{key,value:{userId:user.id,phone,completedAt:new Date().toISOString()}}});
        return {status:'complete',userId:user.id,phone,twoFactorEnabled:!!user.totpSecret} as const;
      });
    }catch(error){
      const code=(error as {code?:string}).code;
      if(code==='P2034'&&attempt<2)continue;
      if(code==='P2002'&&await db.setting.findUnique({where:{key}}))return {status:'already-complete'};
      throw error;
    }
  }
  throw new AppError(503,'Admin phone setup could not finish. Restart the server to retry.');
}

export async function runAdminPhoneSetup(env:Environment=process.env){
  try{
    const result=await setupAdminPhoneOnce(env);
    if(result.status==='disabled')return result;
    console.log(JSON.stringify({event:'admin_phone_setup',...result,message:result.status==='complete'?'Phone login enabled. Remove ADMIN_PHONE_SETUP and ADMIN_PIN from the hosting environment.':'Setup already completed. Existing PIN and sessions were preserved.'}));
    return result;
  }catch(error){
    let reason='SETUP_FAILED',message='Admin phone setup failed. Check the hosting database configuration and restart the server to retry.';
    if(error instanceof ZodError){reason='INVALID_CONFIGURATION';message='Set ADMIN_PHONE to a valid mobile number and ADMIN_PIN to exactly four digits in the hosting environment.';}
    else if(error instanceof AppError){
      reason=error.status===409?'ADMIN_SELECTION_REQUIRED':error.status===404?'ADMIN_NOT_FOUND':'SETUP_FAILED';
      message=error.status===409?'Multiple active administrators found. Set ADMIN_USER_ID to select the existing account.':error.status===404?'No matching active administrator found. Check ADMIN_USER_ID and the hosting database.':message;
    }else if((error as {code?:string}).code==='P2002'){reason='PHONE_IN_USE';message='ADMIN_PHONE is already linked to another account. No login was changed.';}
    else{const diagnostic=databaseFailure(error);if(diagnostic){reason=diagnostic.reason;message=diagnostic.message;}}
    console.error(JSON.stringify({event:'admin_phone_setup_failed',reason,message}));
    if(reason==='ADMIN_SELECTION_REQUIRED'){
      try{
        const admins=await db.user.findMany({where:{role:'SUPER_ADMIN',active:true},select:{id:true,name:true,organization:{select:{name:true}}},take:20});
        console.error(JSON.stringify({event:'admin_phone_setup_candidates',admins:admins.map(user=>({id:user.id,name:user.name,organization:user.organization.name}))}));
      }catch{ /* Keep setup failure reporting separate from application startup. */ }
    }
    return {status:'failed',reason} as const;
  }
}
