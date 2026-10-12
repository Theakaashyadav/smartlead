import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { TOTP } from 'otpauth';
import { db } from './db';
import { appUrl, secret } from './config';
import type { User } from '@/generated/mongo';

export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_ERROR') { super(message); }
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');
export function signedFeedbackToken() {
  const nonce=opaqueToken();
  return `${nonce}.${createHmac('sha256',secret('SESSION_SECRET')).update(nonce).digest('base64url')}`;
}
export function verifyFeedbackSignature(token:string) {
  const [nonce,signature]=token.split('.');
  if(!nonce||!signature)return false;
  const expected=createHmac('sha256',secret('SESSION_SECRET')).update(nonce).digest('base64url');
  return signature.length===expected.length&&timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest,'hex');
  const actual = scryptSync(password,salt,64);
  return expected.length === actual.length && timingSafeEqual(expected,actual);
}
export function encrypt(value: string) {
  const key = Buffer.from(secret('ENCRYPTION_KEY'),'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  const ciphertext = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),ciphertext].map(v=>v.toString('base64url')).join('.');
}
export function decrypt(value: string) {
  const [iv,tag,ciphertext] = value.split('.').map(v=>Buffer.from(v,'base64url'));
  const decipher = createDecipheriv('aes-256-gcm',Buffer.from(secret('ENCRYPTION_KEY'),'hex'),iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
}
const cookieName = 'smartlead_session';
const sessionKey = () => {
  const value = secret('SESSION_SECRET');
  if (value.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters');
  return new TextEncoder().encode(value);
};
export async function loginSession(user: User) {
  const id = opaqueToken();
  await db.authSession.create({data:{id:hash(id),userId:user.id,expiresAt:new Date(Date.now()+7*86400000)}});
  const token = await new SignJWT({sid:id}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('7d').sign(sessionKey());
  (await cookies()).set(cookieName,token,{httpOnly:true,secure:appUrl().startsWith('https://'),sameSite:'lax',path:'/',maxAge:7*86400});
}
export async function currentUser(): Promise<User|null> {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) return null;
  try {
    const {payload} = await jwtVerify(token,sessionKey(),{algorithms:['HS256']});
    const session = await db.authSession.findUnique({where:{id:hash(String(payload.sid))},include:{user:true}});
    if (!session || session.expiresAt < new Date() || !session.user.active || session.userId !== payload.sub) return null;
    return session.user;
  } catch { return null; }
}
export async function logoutSession() {
  const token = (await cookies()).get(cookieName)?.value;
  if (token) try {
    const {payload} = await jwtVerify(token,sessionKey());
    await db.authSession.deleteMany({where:{id:hash(String(payload.sid))}});
  } catch { /* An invalid cookie is also cleared. */ }
  (await cookies()).delete(cookieName);
}
export async function requireUser(roles?: string[]) {
  const user = await currentUser();
  if (!user) throw new AppError(401,'Please sign in','UNAUTHENTICATED');
  if (roles && !roles.includes(user.role)) throw new AppError(403,'You do not have permission for this action','FORBIDDEN');
  return user;
}
export const safeUser = (u: User) => ({id:u.id,name:u.name,email:u.email,role:u.role,organizationId:u.organizationId,twoFactor:!!u.totpSecret});
export function verifyTotp(user: User, code?: string) {
  if (!user.totpSecret) return true;
  return new TOTP({secret:decrypt(user.totpSecret),digits:6,period:30}).validate({token:code||'',window:1}) !== null;
}
export function checkOrigin(request: Request, feedbackOrigin?:string) {
  if (['GET','HEAD','OPTIONS'].includes(request.method)) return;
  const configured=new URL(appUrl());
  const value=request.headers.get('origin');
  if(value){
    let origin:URL;
    try{origin=new URL(value);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.origin!==value)throw new Error('Invalid origin');}
    catch{throw new AppError(403,'Invalid request origin');}
    const loopback=(url:URL)=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    const localAlias=loopback(configured)&&loopback(origin)&&origin.port===configured.port&&origin.protocol===configured.protocol;
    if(origin.origin!==configured.origin&&origin.origin!==feedbackOrigin&&!localAlias)throw new AppError(403,'Invalid request origin. Set APP_URL in the hosting environment to the website\'s public HTTPS address, then apply changes and restart the app.','ORIGIN_MISMATCH');
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError(403,'Cross-site request rejected');
}
export async function rateLimit(key: string, max = 15, windowSeconds = 60) {
  const now = new Date();
  const counter = await db.rateLimit.upsert({where:{key},create:{key,count:1,expiresAt:new Date(Date.now()+windowSeconds*1000)},update:{count:{increment:1}}});
  if(counter.expiresAt <= now) {
    await db.rateLimit.updateMany({where:{key,expiresAt:{lte:now}},data:{count:1,expiresAt:new Date(Date.now()+windowSeconds*1000)}});
    return;
  }
  if (counter.count > max) throw new AppError(429,'Too many requests. Try again shortly.','RATE_LIMITED');
}
export async function audit(userId: string|null, action: string, entityType: string, entityId?: string) {
  await db.auditLog.create({data:{userId,action,entityType,entityId}});
}
