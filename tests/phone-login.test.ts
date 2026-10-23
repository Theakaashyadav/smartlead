import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOTP } from 'otpauth';
import { clearTestModels } from './database-fixture';
const cookieStore=vi.hoisted(()=>new Map<string,string>());
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>cookieStore.has(key)?{value:cookieStore.get(key)}:undefined,set:(key:string,value:string)=>cookieStore.set(key,value),delete:(key:string)=>cookieStore.delete(key)})}));
import { GET, POST, PUT } from '@/app/api/[...path]/route';
import { db } from '@/lib/db';
import { registerOrganization } from '@/lib/organizations';
import { recoverAdminPhoneLogin } from '@/lib/phone-login';
import { encrypt, hash, verifyPassword } from '@/lib/security';

const phone='9876543210',pin='4826',password='ExistingPassword!2026';
const owner=(overrides:Record<string,unknown>={})=>({name:'Phone Owner',organizationName:'Phone Agency',phone,pin,...overrides});
async function request(route:string,method='GET',body?:unknown){
  const req=new Request(`http://localhost:3000/api/${route}`,{method,headers:{origin:'http://localhost:3000','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return (method==='GET'?GET:method==='PUT'?PUT:POST)(req,{params:Promise.resolve({path:route.split('/')})});
}
beforeEach(async()=>{
  cookieStore.clear();
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.deleteMany({where:{id:{not:'legacy'}}});
});
afterAll(()=>db.$disconnect());

describe('phone number and PIN access',()=>{
  it('registers without email, normalizes the number, hashes the PIN, and keeps private credentials out of responses',async()=>{
    const response=await request('auth/register','POST',owner({role:'EXECUTIVE',organizationId:'legacy'}));
    expect(response.status).toBe(201);
    const user=await db.user.findUniqueOrThrow({where:{phone:'+919876543210'}});
    expect(user.email).toBeNull();expect(user.role).toBe('SUPER_ADMIN');expect(user.organizationId).not.toBe('legacy');
    expect(verifyPassword(pin,user.pinHash!)).toBe(true);expect(user.pinHash).not.toBe(pin);
    const result=await response.json();expect(result.data).toMatchObject({phone:'+919876543210',pinEnabled:true});
    expect(result.data.pinHash).toBeUndefined();expect(result.data.passwordHash).toBeUndefined();expect(result.data.pin).toBeUndefined();
    const duplicate=await request('auth/register','POST',owner({phone:'+91 98765 43210'}));
    expect(duplicate.status).toBe(409);expect(await db.organization.count()).toBe(2);
    const other=await registerOrganization(owner({phone:'9876543211'}));
    expect(other.email).toBeNull();expect(other.pinHash).not.toBe(user.pinHash);expect(other.organizationId).not.toBe(user.organizationId);
  });
  it('logs into the same workspace with a national or international number and preserves leading-zero PINs',async()=>{
    const user=await registerOrganization(owner({pin:'0482'}));
    for(const formatted of [phone,'+91 98765 43210']){
      const response=await request('auth/login','POST',{phone:formatted,pin:'0482'});
      expect(response.status).toBe(200);expect((await response.json()).data.organizationId).toBe(user.organizationId);
      expect((await request('auth/me')).status).toBe(200);await request('auth/logout','POST');
      expect((await request('auth/me')).status).toBe(401);
    }
  });
  it('rejects malformed phone numbers and PINs before creating an account',async()=>{
    for(const invalid of [{phone:'bad',pin},{phone,pin:'12'},{phone,pin:'12345'},{phone,pin:'abcd'},{phone,pin:4826}])expect((await request('auth/register','POST',owner(invalid))).status).toBe(400);
    expect(await db.user.count()).toBe(0);
  });
  it('returns the same login error for wrong PINs, missing accounts, and inactive accounts',async()=>{
    const user=await registerOrganization(owner());
    const wrong=await request('auth/login','POST',{phone,pin:'0000'});
    const absent=await request('auth/login','POST',{phone:'9876543211',pin});
    expect(wrong.status).toBe(401);expect(absent.status).toBe(401);expect(await absent.json()).toEqual(await wrong.json());
    await db.user.update({where:{id:user.id},data:{active:false}});
    expect((await request('auth/login','POST',{phone,pin})).status).toBe(401);
    expect(await db.authSession.count()).toBe(0);
  });
  it('limits PIN attempts across number formats and permits login after the window expires',async()=>{
    await registerOrganization(owner());
    for(let i=0;i<5;i++)expect((await request('auth/login','POST',{phone:i%2?'+91 98765 43210':phone,pin:'0000'})).status).toBe(401);
    expect((await request('auth/login','POST',{phone,pin})).status).toBe(429);
    await db.rateLimit.update({where:{key:`login:phone:${hash('+919876543210')}`},data:{expiresAt:new Date(Date.now()-1000)}});
    expect((await request('auth/login','POST',{phone,pin})).status).toBe(200);
  });
  it('keeps authenticator verification on phone login and credential changes',async()=>{
    const user=await registerOrganization(owner());const secret='JBSWY3DPEHPK3PXP';
    await db.user.update({where:{id:user.id},data:{totpSecret:encrypt(secret)}});
    expect((await request('auth/login','POST',{phone,pin})).status).toBe(401);
    const code=new TOTP({secret}).generate();
    expect((await request('auth/login','POST',{phone,pin,code})).status).toBe(200);
    expect((await request('auth/phone','PUT',{phone,pin:'6842',currentCredential:pin})).status).toBe(403);
    expect((await request('auth/phone','PUT',{phone,pin:'6842',currentCredential:pin,code})).status).toBe(200);
  });
  it('clears failed-attempt counts after a successful PIN login and permits repeated successful sign-ins',async()=>{
    await registerOrganization(owner());
    for(let i=0;i<7;i++){
      if(i===2)expect((await request('auth/login','POST',{phone,pin:'0000'})).status).toBe(401);
      expect((await request('auth/login','POST',{phone,pin})).status).toBe(200);
      await request('auth/logout','POST');
    }
    expect(await db.rateLimit.findUnique({where:{key:`login:phone:${hash('+919876543210')}`}})).toBeNull();
  });
  it('links an existing email account after re-verification, preserving its workspace and revoking old sessions and reset links',async()=>{
    const user=await registerOrganization({name:'Existing Owner',organizationName:'Existing Agency',email:'owner@example.test',password});
    expect((await request('auth/phone','PUT',{phone,pin,currentCredential:password})).status).toBe(401);
    expect((await request('auth/login','POST',{email:user.email,password})).status).toBe(200);
    await db.authSession.create({data:{id:hash('another-session'),userId:user.id,expiresAt:new Date(Date.now()+60000)}});
    await db.resetToken.create({data:{id:hash('old-reset'),userId:user.id,expiresAt:new Date(Date.now()+60000)}});
    expect((await request('auth/phone','PUT',{phone,pin,currentCredential:'incorrect'})).status).toBe(403);
    expect((await request('auth/phone','PUT',{phone,pin,currentCredential:password})).status).toBe(200);
    expect(await db.authSession.count({where:{userId:user.id}})).toBe(1);expect(await db.resetToken.count()).toBe(0);
    const linked=await db.user.findUniqueOrThrow({where:{id:user.id}});expect(linked.organizationId).toBe(user.organizationId);expect(linked.email).toBe(user.email);
    await request('auth/logout','POST');expect((await request('auth/login','POST',{phone,pin})).status).toBe(200);
    expect((await (await request('auth/me')).json()).data.id).toBe(user.id);
    expect((await request('auth/login','POST',{email:user.email,password})).status).toBe(401);
    expect((await request('auth/phone','PUT',{phone,pin:'6842',currentCredential:password})).status).toBe(403);
    expect((await request('auth/phone','PUT',{phone,pin:'6842',currentCredential:pin})).status).toBe(200);
  });
  it('rolls back a phone collision without losing the current login or changing either account',async()=>{
    const user=await registerOrganization(owner());await registerOrganization(owner({phone:'9876543211'}));
    await request('auth/login','POST',{phone,pin});
    const response=await request('auth/phone','PUT',{phone:'9876543211',pin:'6842',currentCredential:pin});
    expect(response.status).toBe(409);expect((await request('auth/me')).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({where:{id:user.id}})).phone).toBe('+919876543210');
  });
  it('recovers a single existing administrator without requiring their email and refuses to guess between organisations',async()=>{
    const user=await registerOrganization({name:'Existing Owner',organizationName:'Existing Agency',email:'owner@example.test',password});
    const recovered=await recoverAdminPhoneLogin({phone,pin});
    expect(recovered.id).toBe(user.id);expect(recovered.organizationId).toBe(user.organizationId);expect(await db.organization.count()).toBe(2);
    await registerOrganization(owner({phone:'9876543211'}));
    await expect(recoverAdminPhoneLogin({phone,pin:'6842'})).rejects.toMatchObject({status:409});
    expect(verifyPassword(pin,(await db.user.findUniqueOrThrow({where:{id:user.id}})).pinHash!)).toBe(true);
    expect((await recoverAdminPhoneLogin({phone,pin:'6842'},user.id)).id).toBe(user.id);
    await db.user.update({where:{id:user.id},data:{active:false}});
    await expect(recoverAdminPhoneLogin({phone,pin},user.id)).rejects.toMatchObject({status:404});
  });
});
