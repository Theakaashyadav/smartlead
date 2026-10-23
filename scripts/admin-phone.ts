import '../src/lib/config';
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { db } from '../src/lib/db';
import { AppError } from '../src/lib/security';
import { recoverAdminPhoneLogin } from '../src/lib/phone-login';

async function run(){
  const {values}=parseArgs({options:{list:{type:'boolean'},user:{type:'string'}}});
  if(values.list){
    const admins=await db.user.findMany({where:{role:'SUPER_ADMIN',active:true},select:{id:true,name:true,phone:true,organization:{select:{name:true}}}});
    console.table(admins.map(user=>({id:user.id,name:user.name,phone:user.phone||'Not linked',organisation:user.organization.name})));
    return;
  }
  if(!process.env.ADMIN_PHONE||!process.env.ADMIN_PIN)throw new AppError(400,'Set ADMIN_PHONE and ADMIN_PIN in the server environment. PIN must have four digits.');
  const user=await recoverAdminPhoneLogin({phone:process.env.ADMIN_PHONE,pin:process.env.ADMIN_PIN},values.user||process.env.ADMIN_USER_ID);
  console.log(`Phone login enabled for ${user.name} (${user.phone}). The existing workspace is preserved and previous sessions were signed out.`);
}
run().catch(error=>{
  if(error instanceof AppError)console.error(error.message);
  else if(error instanceof ZodError)console.error('Enter a valid mobile number and a four-digit PIN.');
  else if(error?.code==='P2002')console.error('That phone number is already linked to another account. No credentials were changed.');
  else console.error('Could not update admin login. Check the server database configuration and network access.');
  process.exitCode=1;
}).finally(()=>db.$disconnect());
