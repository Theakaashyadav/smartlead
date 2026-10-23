import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTestModels } from './database-fixture';
import { db, usingSQLite } from '@/lib/db';
import { closeMongoStorage } from '@/lib/mongo-storage';
import { registerOrganization } from '@/lib/organizations';
import { adminPhoneSetupKey, runAdminPhoneSetup, setupAdminPhoneOnce } from '@/lib/admin-phone-setup';
import { encrypt, hash, passwordHash, verifyPassword } from '@/lib/security';

const phone='9876543210',normalized='+919876543210',pin='4826';
const env={ADMIN_PHONE_SETUP:'true',ADMIN_PHONE:phone,ADMIN_PIN:pin};
const owner=(email='owner@example.test')=>registerOrganization({name:'Existing Owner',organizationName:'Existing Agency',email,password:'ExistingPassword!2026'});
beforeEach(async()=>{
  vi.restoreAllMocks();
  await clearTestModels(['FeedbackToken','Feedback','Followup','Message','Assignment','Lead','RuleRecipient','DistributionRule','SheetAccess','SyncLog','Sheet','Employee','AuthSession','ResetToken','User','Sender','GoogleCredential','Job','AuditLog','Setting','RateLimit']);
  await db.organization.deleteMany({where:{id:{not:'legacy'}}});
  if(!usingSQLite)await db.setting.create({data:{key:'storage:project',value:{project:'smartlead',version:1}}});
});
afterAll(async()=>{vi.restoreAllMocks();await db.$disconnect();await closeMongoStorage();});

describe('one-time hosted administrator setup',()=>{
  it('requires explicit opt-in before accessing the database or changing a login',async()=>{
    const transaction=vi.spyOn(db,'$transaction');
    expect(await setupAdminPhoneOnce({ADMIN_PHONE:phone,ADMIN_PIN:pin})).toEqual({status:'disabled'});
    expect(await setupAdminPhoneOnce({...env,ADMIN_PHONE_SETUP:'false'})).toEqual({status:'disabled'});
    expect(transaction).not.toHaveBeenCalled();
  });
  it('links the existing owner atomically, clears stale login attempts, and preserves their workspace and authenticator',async()=>{
    const user=await owner();const secret=encrypt('JBSWY3DPEHPK3PXP');
    await db.user.update({where:{id:user.id},data:{totpSecret:secret}});
    await db.authSession.create({data:{id:'old-session',userId:user.id,expiresAt:new Date(Date.now()+60000)}});
    await db.resetToken.create({data:{id:'old-reset',userId:user.id,expiresAt:new Date(Date.now()+60000)}});
    await db.rateLimit.create({data:{key:`login:phone:${hash(normalized)}`,count:10,expiresAt:new Date(Date.now()+60000)}});
    const sender=await db.sender.create({data:{organizationId:user.organizationId,name:'Existing connection',provider:'WEB'}});
    expect(await setupAdminPhoneOnce(env)).toEqual({status:'complete',userId:user.id,phone:normalized,twoFactorEnabled:true});
    const linked=await db.user.findUniqueOrThrow({where:{id:user.id}});
    expect(linked.organizationId).toBe(user.organizationId);expect(linked.email).toBe(user.email);expect(linked.totpSecret).toBe(secret);
    expect(verifyPassword(pin,linked.pinHash!)).toBe(true);expect(await db.organization.count()).toBe(2);
    expect(await db.sender.findUnique({where:{id:sender.id}})).not.toBeNull();
    expect(await db.authSession.count()).toBe(0);expect(await db.resetToken.count()).toBe(0);expect(await db.rateLimit.count()).toBe(0);
    const marker=await db.setting.findUniqueOrThrow({where:{key:adminPhoneSetupKey(normalized)}});
    expect(marker.value).toEqual({userId:user.id,phone:normalized,completedAt:expect.any(String)});
    expect(await db.auditLog.count({where:{action:'SET_PHONE_LOGIN'}})).toBe(1);
  });
  it('preserves later PIN changes and sessions when the server restarts, including after ADMIN_PIN is removed',async()=>{
    const user=await owner();await setupAdminPhoneOnce(env);
    const changedHash=passwordHash('6842');await db.user.update({where:{id:user.id},data:{pinHash:changedHash}});
    await db.authSession.create({data:{id:'keep-session',userId:user.id,expiresAt:new Date(Date.now()+60000)}});
    expect(await setupAdminPhoneOnce({...env,ADMIN_PHONE:'+91 98765 43210',ADMIN_PIN:'0000'})).toEqual({status:'already-complete'});
    expect(await setupAdminPhoneOnce({ADMIN_PHONE_SETUP:'true',ADMIN_PHONE:phone})).toEqual({status:'already-complete'});
    expect((await db.user.findUniqueOrThrow({where:{id:user.id}})).pinHash).toBe(changedHash);
    expect(await db.authSession.count()).toBe(1);expect(await db.auditLog.count({where:{action:'SET_PHONE_LOGIN'}})).toBe(1);
  });
  it('refuses to guess between owners and accepts an explicit existing administrator ID',async()=>{
    const first=await owner(),second=await owner('other@example.test');
    await expect(setupAdminPhoneOnce(env)).rejects.toMatchObject({status:409});
    const output=vi.spyOn(console,'error').mockImplementation(()=>{});
    expect(await runAdminPhoneSetup(env)).toEqual({status:'failed',reason:'ADMIN_SELECTION_REQUIRED'});
    const candidates=JSON.parse(output.mock.calls[1][0]);
    expect(candidates.admins.map((admin:{id:string})=>admin.id).sort()).toEqual([first.id,second.id].sort());
    expect(await db.setting.count({where:{key:{startsWith:'admin-phone:setup:'}}})).toBe(0);expect(await db.auditLog.count()).toBe(0);
    expect(await setupAdminPhoneOnce({...env,ADMIN_USER_ID:second.id})).toMatchObject({status:'complete',userId:second.id});
    expect((await db.user.findUniqueOrThrow({where:{id:first.id}})).pinHash).toBeNull();
  });
  it('rolls back a phone collision without revoking existing sessions or claiming completion',async()=>{
    const first=await owner();const other=await registerOrganization({name:'Other Owner',organizationName:'Other Agency',phone,pin:'6842'});
    await db.authSession.create({data:{id:'keep-session',userId:first.id,expiresAt:new Date(Date.now()+60000)}});
    await expect(setupAdminPhoneOnce({...env,ADMIN_USER_ID:first.id})).rejects.toMatchObject({code:'P2002'});
    expect(await db.setting.count({where:{key:{startsWith:'admin-phone:setup:'}}})).toBe(0);expect(await db.authSession.count()).toBe(1);expect(await db.auditLog.count()).toBe(0);
    expect((await db.user.findUniqueOrThrow({where:{id:first.id}})).phone).toBeNull();
    expect(verifyPassword('6842',(await db.user.findUniqueOrThrow({where:{id:other.id}})).pinHash!)).toBe(true);
  });
  it('rejects incomplete credentials and retries after an unsuccessful initial setup',async()=>{
    for(const invalid of [{ADMIN_PHONE:undefined},{ADMIN_PHONE:'bad'},{ADMIN_PIN:undefined},{ADMIN_PIN:'12'},{ADMIN_PIN:'abcd'}])await expect(setupAdminPhoneOnce({...env,...invalid})).rejects.toThrow();
    await expect(setupAdminPhoneOnce(env)).rejects.toMatchObject({status:404});
    expect(await db.setting.count({where:{key:{startsWith:'admin-phone:setup:'}}})).toBe(0);const user=await owner();
    expect(await setupAdminPhoneOnce(env)).toMatchObject({status:'complete',userId:user.id});
  });
  it.skipIf(usingSQLite)('coordinates concurrent server starts without resetting a login twice',async()=>{
    const user=await owner();
    const results=await Promise.all([setupAdminPhoneOnce(env),setupAdminPhoneOnce({...env,ADMIN_PHONE:'+91 98765 43210'})]);
    expect(results.map(result=>result.status).sort()).toEqual(['already-complete','complete']);
    expect(await db.auditLog.count({where:{userId:user.id,action:'SET_PHONE_LOGIN'}})).toBe(1);
    expect(await db.setting.count({where:{key:adminPhoneSetupKey(normalized)}})).toBe(1);
  });
  it('reports setup errors without exposing raw database credentials or the PIN',async()=>{
    const privateDetails='mongodb://private-user:private-password@private-host/smartlead';
    const output=vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.spyOn(db,'$transaction').mockRejectedValueOnce(new Error(`${privateDetails} PIN ${pin}`));
    expect(await runAdminPhoneSetup(env)).toEqual({status:'failed',reason:'SETUP_FAILED'});
    const log=output.mock.calls.flat().join(' ');
    expect(log).toContain('admin_phone_setup_failed');expect(log).not.toContain(privateDetails);expect(log).not.toContain(pin);
  });
  it('reports success and authenticator requirements in server logs without logging the PIN',async()=>{
    const user=await owner();await db.user.update({where:{id:user.id},data:{totpSecret:encrypt('JBSWY3DPEHPK3PXP')}});
    const output=vi.spyOn(console,'log').mockImplementation(()=>{});
    expect(await runAdminPhoneSetup(env)).toMatchObject({status:'complete'});
    const log=JSON.parse(output.mock.calls[0][0]);
    expect(log).toMatchObject({event:'admin_phone_setup',status:'complete',twoFactorEnabled:true});expect(log.pin).toBeUndefined();expect(log.pinHash).toBeUndefined();
  });
});
