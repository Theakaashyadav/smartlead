import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, databaseHealth, usingSQLite } from '@/lib/db';
import { isDemo, appUrl } from '@/lib/config';
import { AppError, audit, checkOrigin, encrypt, hash, loginSession, logoutSession, opaqueToken, passwordHash, rateLimit, requireUser, safeUser, verifyPassword, verifyTotp, signedFeedbackToken } from '@/lib/security';
import { accessibleLead, accessibleSheet, employeeScope, leadScope, sheetScope } from '@/lib/permissions';
import { allowedStatuses, assignLead, drainJobs, enqueue, getFeedbackAccess, retryMessage, saveFeedback, synchronizeSheet, transaction, updateLeadSheetNow } from '@/lib/engine';
import { DEFAULT_TEMPLATE, employeeSchema, feedbackSchema, loginSchema, ruleSchema, sheetSchema, STATUSES, validateTemplate } from '@/lib/validation';
import { leadFilters, leadInclude, workspace } from '@/lib/analytics';
import { inspectSpreadsheet } from '@/lib/google';
import { whatsappProvider } from '@/lib/whatsapp';
import { csv, reportRows, safeCell } from '@/lib/reports';
import { simpleAction } from '@/lib/simple';
import { organizationSettingKey, registerOrganization, registrationSchema } from '@/lib/organizations';
import { phoneCredentialsSchema, setPhoneLogin } from '@/lib/phone-login';
import { feedbackBaseURL } from '@/lib/feedback-url';
import { databaseFailure, safeDatabaseErrorCode } from '@/lib/database-errors';
import { requireWhatsAppWorker, workerHeartbeatFresh } from '@/lib/worker-status';
import { SIMPLE_POLL_SECONDS, SEND_INTERVAL_MS } from '@/lib/automation-policy';
import { finishGoogleAuthorization, googleAuthorizationUsesPopup, startGoogleAuthorization } from '@/lib/google-oauth';

export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
const ok=(data:unknown,status=200)=>NextResponse.json({data},{status,headers:{'Cache-Control':'no-store'}});
const managers=['SUPER_ADMIN','MANAGER'];
async function body(request:Request){if(Number(request.headers.get('content-length')||0)>100000)throw new AppError(413,'Request body too large');try{return await request.json();}catch{throw new AppError(400,'Invalid JSON request');}}
async function demoDrain(organizationId:string){if(isDemo())await drainJobs(100,0,organizationId);}
async function handler(request:Request,context:Context):Promise<Response> {
  try{
    const {path}=await context.params;
    const route=path.join('/');const method=request.method;const url=new URL(request.url);const p=url.searchParams;
    if(route==='health'){
      let appOrigin:string|null=null;
      try{const app=new URL(appUrl());if(['http:','https:'].includes(app.protocol)&&!app.username&&!app.password)appOrigin=app.origin;}catch{}
      const configuration={appOrigin,database:usingSQLite?'sqlite':'mongodb',missing:['APP_URL','SESSION_SECRET','ENCRYPTION_KEY',...(!usingSQLite?['MONGODB_URI']:[])].filter(key=>!process.env[key])};
      try{await databaseHealth();}catch(error){
        const diagnostic=databaseFailure(error);
        console.error(JSON.stringify({event:'database_health_error',code:safeDatabaseErrorCode(error),type:error instanceof Error?error.name:'Error',...diagnostic}));
        return NextResponse.json({error:{code:'DATABASE_UNAVAILABLE',message:diagnostic?.message||'Database connection failed. Check the hosting environment variables, database network access, and server logs.'},configuration,...(diagnostic?{diagnostic}:{})},{status:503,headers:{'Cache-Control':'no-store'}});
      }
      const worker=await db.setting.findUnique({where:{key:'simple:worker'}});
      const workerRunning=workerHeartbeatFresh(worker?.value);
      const failure=!workerRunning?await db.setting.findUnique({where:{key:'simple:worker-error'}}):null;
      return ok({status:'ok',mode:isDemo()?'demo':'production',database:usingSQLite?'sqlite':'mongodb',appOrigin,workerRunning,workerManager:process.env.SMARTLEAD_EXTERNAL_WORKER==='true'?'external':'nextjs',workerDiagnostic:failure?.value||null,automation:{publicSheetPollSeconds:SIMPLE_POLL_SECONDS,minimumSendIntervalMs:SEND_INTERVAL_MS,skipAlreadySentLeads:true,recipientLeadCounts:true}});
    }
    if(route==='webhooks/whatsapp'){
      if(method==='GET'){
        if(!process.env.META_WEBHOOK_VERIFY_TOKEN||p.get('hub.verify_token')!==process.env.META_WEBHOOK_VERIFY_TOKEN)throw new AppError(403,'Invalid verification token');
        return new Response(p.get('hub.challenge')||'');
      }
      const raw=await request.text();const signature=request.headers.get('x-hub-signature-256')||'';
      if(!process.env.META_APP_SECRET)throw new AppError(503,'Webhook verification is not configured');
      const expected=`sha256=${createHmac('sha256',process.env.META_APP_SECRET).update(raw).digest('hex')}`;
      if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new AppError(403,'Invalid webhook signature');
      for(const sender of await db.sender.findMany({where:{provider:'META'}}))await whatsappProvider(sender).handleIncomingEvents(JSON.parse(raw));
      return ok({received:true});
    }
    checkOrigin(request,path[0]==='feedback'&&path.length===2&&method==='POST'?await feedbackBaseURL():undefined);
    if(route==='auth/register'&&method==='POST'){
      const input=registrationSchema.parse(await body(request));
      const identifier='phone' in input?input.phone:input.email;
      await rateLimit('register:global',100,3600);
      await rateLimit(`register:${hash(identifier)}`,5,3600);
      const user=await registerOrganization(input);
      await loginSession(user);await audit(user.id,'REGISTER_ORGANIZATION','organization',user.organizationId);
      return ok(safeUser(user),201);
    }
    if(route==='auth/login'&&method==='POST'){
      const data=loginSchema.parse(await body(request));
      const phoneLogin='phone' in data;
      const loginKey=phoneLogin?`login:phone:${hash(data.phone)}`:`login:${hash(data.email.toLowerCase())}`;
      await rateLimit(loginKey,phoneLogin?5:10,900);
      const user=await db.user.findUnique({where:phoneLogin?{phone:data.phone}:{email:data.email.toLowerCase()}});
      const stored=phoneLogin?user?.pinHash:!user?.pinHash?user?.passwordHash:undefined;
      const valid=verifyPassword(phoneLogin?data.pin:data.password,stored||'00000000000000000000000000000000:'+ '0'.repeat(128));
      if(!user?.active||!valid||!verifyTotp(user,data.code))throw new AppError(401,phoneLogin?'Phone number, PIN, or verification code is incorrect':'Email, password, or verification code is incorrect');
      if(phoneLogin)await db.rateLimit.deleteMany({where:{key:loginKey}});
      await loginSession(user);await audit(user.id,'LOGIN','user',user.id);return ok(safeUser(user));
    }
    if(route==='auth/logout'&&method==='POST'){await logoutSession();return ok({loggedOut:true});}
    if(route==='auth/reset-request'&&method==='POST'){
      const {email}=z.object({email:z.email()}).parse(await body(request));await rateLimit(`reset:${hash(email)}`,3,3600);
      const user=await db.user.findUnique({where:{email:email.toLowerCase()}});
      if(user?.email && !user.pinHash && process.env.SMTP_HOST){
        const raw=opaqueToken();await db.resetToken.create({data:{id:hash(raw),userId:user.id,expiresAt:new Date(Date.now()+30*60000)}});
        const nodemailer=await import('nodemailer');
        const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT)||587,secure:Number(process.env.SMTP_PORT)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}});
        await transporter.sendMail({from:process.env.SMTP_FROM,to:user.email,subject:'Reset your SmartLead password',text:`Reset your password within 30 minutes: ${appUrl()}/login?reset=${raw}`});
      }
      return ok({message:'If the account exists and email delivery is configured, a reset link will be sent.'});
    }
    if(route==='auth/reset'&&method==='POST'){
      const {token,password}=z.object({token:z.string().min(30),password:z.string().min(12).max(128)}).parse(await body(request));
      const reset=await db.resetToken.findUnique({where:{id:hash(token)}});
      if(!reset||reset.usedAt||reset.expiresAt<new Date())throw new AppError(410,'Reset link expired or already used');
      await transaction(async tx=>{const claimed=await tx.resetToken.updateMany({where:{id:reset.id,OR:[{usedAt:null},...(!usingSQLite?[{usedAt:{isSet:false}}]:[])],expiresAt:{gt:new Date()}},data:{usedAt:new Date()}});if(!claimed.count)throw new AppError(410,'Reset link already used');await tx.user.update({where:{id:reset.userId},data:{passwordHash:passwordHash(password)}});await tx.authSession.deleteMany({where:{userId:reset.userId}});});return ok({message:'Password updated. Sign in with your new password.'});
    }
    if(path[0]==='feedback'&&path[1]){
      await rateLimit(`feedback:${hash(path[1])}`,60,60);
      const access=await getFeedbackAccess(path[1]);
      const writebackAvailable=true;
      const writebackFailure=method==='GET'&&access.assignment.lead.writebackStatus==='ERROR'?await db.job.findFirst({where:{type:'WRITEBACK',entityId:access.assignment.leadId,status:{in:['PENDING','DEAD']}},orderBy:{runAt:'desc'},select:{error:true}}):null;
      if(method==='GET')return ok({simple:access.assignment.lead.sheet.connectionType.startsWith('SIMPLE_'),lead:{id:access.assignment.lead.id,customerName:access.assignment.lead.customerName,project:access.assignment.lead.sheet.connectionType.startsWith('SIMPLE_')?access.assignment.lead.sheet.project:access.assignment.lead.project,mobile:access.assignment.lead.mobile,location:access.assignment.lead.location,sheetName:access.assignment.lead.sheet.name,questions:(access.assignment.lead.sourceData as {questions?:unknown[]}|null)?.questions||[],source:access.assignment.lead.source,status:access.assignment.lead.status,lastFeedback:access.assignment.lead.lastFeedback,writebackStatus:access.assignment.lead.writebackStatus,writebackAvailable,writebackError:writebackFailure?.error||null,updatedAt:access.assignment.lead.updatedAt,nextFollowupAt:access.assignment.lead.nextFollowupAt,version:access.assignment.lead.version},employee:{name:access.assignment.employee.name},statuses:await allowedStatuses(access.assignment.lead.sheetId)});
      if(method==='POST'){await saveFeedback(access.assignmentId,await body(request),undefined,access.id);const writeback=await updateLeadSheetNow(access.assignment.leadId);return ok({message:writeback.status==='SYNCED'?'Status and feedback saved to Google Sheet.':'Feedback saved. '+(writeback.error||'Google Sheet update is in progress.'),writeback});}
    }
    const user=await requireUser();
    await rateLimit(`api:${user.id}`,300,60);
    if(path[0]==='simple')return ok(await simpleAction(path.slice(1),method,request,user));
    if(route==='auth/me')return ok(safeUser(user));
    if(route==='auth/phone'&&method==='PUT'){
      await rateLimit(`phone-settings:${user.id}`,5,900);
      const data=phoneCredentialsSchema.extend({currentCredential:z.string().min(1).max(128),code:z.string().max(6).optional()}).parse(await body(request));
      if(!verifyPassword(data.currentCredential,user.pinHash||user.passwordHash)||!verifyTotp(user,data.code))throw new AppError(403,'Current PIN, password, or verification code is incorrect');
      const updated=await setPhoneLogin(user.id,data);
      await loginSession(updated);return ok(safeUser(updated));
    }
    if(route==='auth/password'&&method==='PUT'){
      const data=z.object({currentPassword:z.string(),password:z.string().min(12).max(128)}).parse(await body(request));
      if(!verifyPassword(data.currentPassword,user.passwordHash))throw new AppError(403,'Current password is incorrect');
      await db.user.update({where:{id:user.id},data:{passwordHash:passwordHash(data.password)}});await db.authSession.deleteMany({where:{userId:user.id}});await loginSession(user);return ok({updated:true});
    }
    if(route==='auth/totp'&&method==='POST'){
      const data=z.object({password:z.string(),code:z.string().optional(),secret:z.string().optional(),disable:z.boolean().optional()}).parse(await body(request));
      if(!verifyPassword(data.password,user.passwordHash))throw new AppError(403,'Current password is incorrect');
      if(data.disable){if(!verifyTotp(user,data.code))throw new AppError(400,'Invalid verification code');await db.user.update({where:{id:user.id},data:{totpSecret:null}});return ok({enabled:false});}
      if(data.secret&&data.code){const totp=new TOTP({secret:data.secret});if(totp.validate({token:data.code,window:1})===null)throw new AppError(400,'Invalid verification code');await db.user.update({where:{id:user.id},data:{totpSecret:encrypt(data.secret)}});return ok({enabled:true});}
      const secret=new Secret({size:20}).base32;const totp=new TOTP({issuer:'SmartLead',label:user.phone||user.email||user.name,secret});return ok({secret,qr:await QRCode.toDataURL(totp.toString())});
    }
    if(route==='workspace'||route==='dashboard/overview'||(path[0]==='dashboard'&&path[1]==='sheets')){if(path[2])p.set('sheet',path[2]);return ok({...await workspace(user,p),demo:isDemo()});}
    if(route==='sheets'&&method==='GET')return ok(await db.sheet.findMany({where:sheetScope(user),include:{rule:{include:{recipients:true}}}}));
    if(route==='sheets/inspect'&&method==='POST'){
      await requireUser(['SUPER_ADMIN']);const data=z.object({spreadsheetId:z.string(),credentialId:z.string().nullable().optional()}).parse(await body(request));return ok(await inspectSpreadsheet(data.spreadsheetId,data.credentialId,user.organizationId));
    }
    if(route==='sheets/connect'&&method==='POST'){
      await requireUser(['SUPER_ADMIN']);const data=sheetSchema.parse(await body(request));if(data.connectionType==='DEMO'&&!isDemo())throw new AppError(400,'Demo sources are disabled');
      if(data.credentialId&&!await db.googleCredential.findFirst({where:{id:data.credentialId,organizationId:user.organizationId},select:{id:true}}))throw new AppError(400,'Google credential not found in your organisation');
      if(data.connectionType!=='DEMO'){const info=await inspectSpreadsheet(data.spreadsheetId,data.credentialId,user.organizationId);const tab=info.tabs.find((t:{id:number;name:string})=>t.id===data.worksheetId&&t.name===data.worksheetName);if(!tab)throw new AppError(400,'Select a valid worksheet');}
      const sheet=await db.sheet.create({data:{...data,organizationId:user.organizationId,rule:{create:{template:DEFAULT_TEMPLATE,mode:'MANUAL'}}}});
      if(data.connectionType==='DEMO')await db.setting.create({data:{key:`demo-source:${sheet.id}`,value:[]}});
      await audit(user.id,'CONNECT_SHEET','sheet',sheet.id);await enqueue(db,'SYNC',sheet.id,`sync:initial:${sheet.id}`);await demoDrain(user.organizationId);return ok(sheet,201);
    }
    if(path[0]==='sheets'&&path[1]){
      const sheet=await accessibleSheet(user,path[1]);
      if(path[2]==='sync'&&method==='POST'){await requireUser(managers);await rateLimit(`sync:${sheet.id}`,2,60);await enqueue(db,'SYNC',sheet.id,`sync:manual:${sheet.id}:${Math.floor(Date.now()/30000)}`);await demoDrain(user.organizationId);return ok({message:isDemo()?'Synchronization completed':'Synchronization queued'});}
      if(path[2]==='settings'&&method==='PUT'){
        await requireUser(['SUPER_ADMIN']);const data=sheetSchema.parse(await body(request));
        if(data.spreadsheetId!==sheet.spreadsheetId||data.worksheetId!==sheet.worksheetId||data.connectionType!==sheet.connectionType||data.credentialId!==sheet.credentialId)throw new AppError(400,'Source identity cannot change. Add a separate connection instead.');
        const updated=await db.sheet.update({where:{id:sheet.id},data});await audit(user.id,'UPDATE_SHEET','sheet',sheet.id);return ok(updated);
      }
      if(path[2]==='source'&&isDemo())return ok(await db.setting.findUnique({where:{key:`demo-source:${sheet.id}`}}));
      if(path[2]==='demo-lead'&&method==='POST'){
        await requireUser(['SUPER_ADMIN']);if(!isDemo()||sheet.connectionType!=='DEMO')throw new AppError(400,'Available only for demo sources');
        const data=z.object({customerName:z.string().min(2),mobile:z.string(),budget:z.string().optional()}).parse(await body(request));const source=await db.setting.findUnique({where:{key:`demo-source:${sheet.id}`}});const rows=(source?.value||[]) as unknown as Array<Record<string,unknown>>;
        rows.push({stableId:opaqueToken(),row:rows.length+2,values:{...data,project:sheet.project,source:'Demo form',leadDate:new Date().toISOString()}});await db.setting.upsert({where:{key:`demo-source:${sheet.id}`},create:{key:`demo-source:${sheet.id}`,value:JSON.parse(JSON.stringify(rows))},update:{value:JSON.parse(JSON.stringify(rows))}});await enqueue(db,'SYNC',sheet.id,`sync:demo:${opaqueToken()}`);await demoDrain(user.organizationId);return ok({created:true},201);
      }
      if(path.length===2&&method==='GET')return ok(await db.sheet.findUnique({where:{id:sheet.id},include:{rule:{include:{recipients:true}},syncLogs:{orderBy:{createdAt:'desc'},take:50}}}));
    }
    if(path[0]==='distribution'&&path[1]&&method==='PUT'){
      await requireUser(managers);await accessibleSheet(user,path[1]);const data=ruleSchema.parse(await body(request));if(!validateTemplate(data.template))throw new AppError(400,'Use supported template variables and include {{feedback_link}}');
      if(data.senderId&&!await db.sender.findFirst({where:{id:data.senderId,organizationId:user.organizationId}}))throw new AppError(400,'Sender not found');
      const employees=await db.employee.findMany({where:{AND:[employeeScope(user),{id:{in:data.recipients.map(r=>r.employeeId)},active:true}]}});if(employees.length!==data.recipients.length)throw new AppError(403,'Recipients must be active members of your authorized team');
      const {recipients,...values}=data;
      const rule=await transaction(async tx=>{const rule=await tx.distributionRule.upsert({where:{sheetId:path[1]},create:{sheetId:path[1],...values},update:values});await tx.ruleRecipient.deleteMany({where:{ruleId:rule.id}});for(const [position,r]of recipients.entries())await tx.ruleRecipient.create({data:{ruleId:rule.id,...r,position}});return rule;});
      await audit(user.id,'UPDATE_DISTRIBUTION','sheet',path[1]);
      // Enabling/changing a rule also resumes leads that were waiting for configuration.
      if(data.enabled&&data.mode!=='MANUAL')for(const l of await db.lead.findMany({where:{sheetId:path[1],sourceDeleted:false,assignments:{none:{active:true}}},select:{id:true}}))await enqueue(db,'ASSIGN',l.id,`assign:rule:${l.id}:${opaqueToken()}`);
      await demoDrain(user.organizationId);return ok(rule);
    }
    if(route==='leads'&&method==='GET'){
      const where={AND:[leadScope(user),leadFilters(p)]};const page=Math.max(1,Number(p.get('page'))||1),limit=Math.min(100,Math.max(1,Number(p.get('limit'))||25));
      const [items,total]=await Promise.all([db.lead.findMany({where,include:leadInclude,skip:(page-1)*limit,take:limit,orderBy:{createdAt:'desc'}}),db.lead.count({where})]);return ok({items,total,page,limit});
    }
    if(['leads/assign','leads/reassign'].includes(route)&&method==='POST'){
      await requireUser(managers);const data=z.object({leadIds:z.array(z.string()).min(1).max(100),employeeId:z.string()}).parse(await body(request));
      for(const id of data.leadIds)await accessibleLead(user,id);
      const results=[];for(const id of data.leadIds)results.push(await assignLead(id,data.employeeId,user.id,route==='leads/reassign'));await demoDrain(user.organizationId);return ok(results);
    }
    if(path[0]==='leads'&&path[1]){
      const lead=await accessibleLead(user,path[1]);
      if(path[2]==='feedback'&&method==='POST'){
        const assignment=lead.assignments.find(a=>a.isPrimary);if(!assignment)throw new AppError(400,'Assign an accountable owner first');await saveFeedback(assignment.id,await body(request),user.id);const writeback=await updateLeadSheetNow(lead.id);return ok({message:'Lead feedback submitted successfully.',writeback});
      }
      if(path[2]==='feedback-link'&&method==='POST'){
        const assignment=lead.assignments.find(a=>a.isPrimary);if(!assignment)throw new AppError(400,'Assign an accountable owner first');const raw=signedFeedbackToken();await db.feedbackToken.create({data:{assignmentId:assignment.id,tokenHash:hash(raw),expiresAt:new Date(Date.now()+7*86400000)}});await audit(user.id,'ISSUE_FEEDBACK_LINK','lead',lead.id);return ok({url:`${appUrl()}/feedback/${raw}`});
      }
      if(path[2]==='writeback'&&method==='POST'){await requireUser(managers);await enqueue(db,'WRITEBACK',lead.id,`writeback:manual:${lead.id}:${opaqueToken()}`);await demoDrain(user.organizationId);return ok({queued:true});}
      if(path.length===2&&method==='GET')return ok({...lead,statuses:await allowedStatuses(lead.sheetId)});
    }
    if(route==='employees'&&method==='GET')return ok(await db.employee.findMany({where:employeeScope(user)}));
    if(route==='employees'&&method==='POST'){
      await requireUser(['SUPER_ADMIN']);const {email,password,...data}=employeeSchema.parse(await body(request));if(email&&!password)throw new AppError(400,'Set a password for employee login');
      const employee=await db.employee.create({data:{...data,organization:{connect:{id:user.organizationId}},...(email?{user:{create:{organization:{connect:{id:user.organizationId}},name:data.name,email:email.toLowerCase(),passwordHash:passwordHash(password!),role:'EXECUTIVE'}}}:{})}});await audit(user.id,'ADD_EMPLOYEE','employee',employee.id);return ok(employee,201);
    }
    if(path[0]==='employees'&&path[1]){
      const employee=await db.employee.findFirst({where:{AND:[employeeScope(user),{id:path[1]}]}});if(!employee)throw new AppError(404,'Employee not found');
      if(method==='PUT'){await requireUser(['SUPER_ADMIN']);const {email,password,...data}=employeeSchema.parse(await body(request));await db.employee.update({where:{id:employee.id},data});if(employee.userId)await db.user.update({where:{id:employee.userId},data:{active:data.active,name:data.name}});await audit(user.id,'UPDATE_EMPLOYEE','employee',employee.id);return ok({updated:true});}
      if(method==='GET'){p.set('employee',employee.id);return ok(await workspace(user,p));}
    }
    if(route==='whatsapp'||path[0]==='whatsapp'){
      await requireUser(['SUPER_ADMIN']);
      if(route==='whatsapp'&&method==='GET')return ok(await db.sender.findMany({where:{organizationId:user.organizationId},select:{id:true,name:true,phone:true,status:true,provider:true,lastConnectedAt:true,lastError:true,qrCode:true}}));
      if(route==='whatsapp'&&method==='POST'){
        const data=z.object({name:z.string().min(2).max(100),provider:z.enum(['DEMO','WEB','META']),phone:z.string().optional(),phoneNumberId:z.string().optional(),accessToken:z.string().optional()}).parse(await body(request));if(data.provider==='DEMO'&&!isDemo())throw new AppError(400,'Demo providers are disabled');if(data.provider==='META'&&(!data.phoneNumberId||!data.accessToken))throw new AppError(400,'Meta requires a phone number ID and access token');
        const sender=await db.sender.create({data:{organizationId:user.organizationId,name:data.name,provider:data.provider,phone:data.phone,encryptedCredentials:data.provider==='META'?encrypt(JSON.stringify({phoneNumberId:data.phoneNumberId,accessToken:data.accessToken})):null}});await audit(user.id,'CREATE_SENDER','sender',sender.id);return ok({id:sender.id},201);
      }
      const id=path[1]||p.get('id');if(!id)throw new AppError(400,'Select a sender account');const sender=await db.sender.findFirst({where:{id,organizationId:user.organizationId}});if(!sender)throw new AppError(404,'Sender not found');
      if(path[2]==='connect'&&method==='POST'){
        if(sender.provider!=='DEMO')await requireWhatsAppWorker();
        await transaction(async tx=>{if(sender.status!=='CONNECTED')await tx.sender.update({where:{id},data:{status:'CONNECTING',lastError:null,qrCode:null}});await enqueue(tx,'CONNECT',id,`connect:${id}:${Math.floor(Date.now()/10000)}`);});
        await demoDrain(user.organizationId);await audit(user.id,'CONNECT_SENDER','sender',id);return ok({connecting:true});
      }
      if(path[2]==='disconnect'&&method==='POST'){await enqueue(db,'DISCONNECT',id,`disconnect:${id}:${opaqueToken()}`);await demoDrain(user.organizationId);await audit(user.id,'DISCONNECT_SENDER','sender',id);return ok({disconnected:true});}
      if(path[2]==='qr'||path[2]==='status')return ok({id:sender.id,status:sender.status,qrCode:sender.qrCode,phone:sender.phone,lastError:sender.lastError});
    }
    if(route==='notifications'&&method==='GET')return ok(await db.message.findMany({where:{lead:{AND:[leadScope(user),leadFilters(p)]},...(p.get('status')?{status:p.get('status')!}:{})},select:{id:true,leadId:true,lead:{select:{customerName:true,sheet:{select:{name:true}}}},recipient:true,sender:{select:{name:true,provider:true}},providerMessageId:true,status:true,uncertain:true,attemptCount:true,queuedAt:true,submittedAt:true,lastAttemptAt:true,failureReason:true},orderBy:{queuedAt:'desc'},take:250}));
    if(path[0]==='notifications'&&path[1]&&path[2]==='retry'&&method==='POST'){await requireUser(managers);const msg=await db.message.findUnique({where:{id:path[1]}});if(!msg)throw new AppError(404,'Notification not found');await accessibleLead(user,msg.leadId);await retryMessage(msg.id,user.id);await demoDrain(user.organizationId);return ok({queued:true});}
    if(route==='feedback-management'&&method==='GET')return ok(await db.feedback.findMany({where:{lead:leadScope(user)},include:{lead:{select:{id:true,customerName:true,project:true}},assignment:{include:{employee:{select:{name:true}}}}},orderBy:{submittedAt:'desc'},take:250}));
    if(route==='followups'&&method==='GET')return ok(await db.followup.findMany({where:{lead:leadScope(user)},include:{lead:{select:{id:true,customerName:true,project:true,mobile:true}},employee:{select:{name:true}}},orderBy:{scheduledAt:'asc'},take:250}));
    if(path[0]==='followups'&&path[1]&&method==='PUT'){
      const f=await db.followup.findFirst({where:{id:path[1],lead:leadScope(user)}});if(!f)throw new AppError(404,'Follow-up not found');const data=z.object({completed:z.boolean().optional(),scheduledAt:z.iso.datetime().optional()}).parse(await body(request));
      await transaction(async tx=>{await tx.followup.update({where:{id:f.id},data:data.completed?{status:'COMPLETED',completedAt:new Date()}:{scheduledAt:new Date(data.scheduledAt!),status:'PENDING',remindedAt:null}});const next=await tx.followup.findFirst({where:{leadId:f.leadId,status:'PENDING'},orderBy:{scheduledAt:'asc'}});const lead=await tx.lead.update({where:{id:f.leadId},data:{nextFollowupAt:next?.scheduledAt||null,version:{increment:1},writebackStatus:'PENDING'}});await enqueue(tx,'WRITEBACK',f.leadId,`writeback:followup:${lead.id}:${lead.version}`);await tx.auditLog.create({data:{userId:user.id,action:data.completed?'COMPLETE_FOLLOWUP':'RESCHEDULE_FOLLOWUP',entityType:'lead',entityId:f.leadId}});});await demoDrain(user.organizationId);return ok({updated:true});
    }
    if(route==='reports')return ok(await reportRows(user,p));
    if(route==='reports/export'){
      const rows=await reportRows(user,p);const format=p.get('format')||'csv';
      await audit(user.id,'EXPORT_REPORT','report',p.get('type')||'leads');
      if(format==='csv')return new Response(csv(rows),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="smartlead-report.csv"','Cache-Control':'no-store'}});
      if(format==='xlsx'){
        const ExcelJS=(await import('exceljs')).default;const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('SmartLead');const columns=Object.keys(rows[0]||{});sheet.columns=columns.map(k=>({header:k,key:k,width:25}));for(const row of rows)sheet.addRow(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,safeCell(v)])));sheet.getRow(1).font={bold:true};const buffer=await workbook.xlsx.writeBuffer();return new Response(new Uint8Array(buffer),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="smartlead-report.xlsx"','Cache-Control':'no-store'}});
      }
      if(format==='pdf'){
        const PDFDocument=(await import('pdfkit')).default;const doc=new PDFDocument({margin:35});const chunks:Buffer[]=[];const done=new Promise<Buffer>(resolve=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));});doc.fontSize(20).text('SmartLead report');doc.fontSize(9).text(`Generated ${new Date().toISOString()} | ${rows.length} records`);for(const row of rows){doc.moveDown();for(const [key,value]of Object.entries(row))doc.text(`${key}: ${String(value??'')}`);}doc.end();return new Response(new Uint8Array(await done),{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="smartlead-report.pdf"','Cache-Control':'no-store'}});
      }
      throw new AppError(400,'Supported formats: csv, xlsx, pdf');
    }
    if(route==='settings'&&method==='PUT'){
      await requireUser(['SUPER_ADMIN']);const data=z.object({name:z.string().min(2).max(100),timezone:z.literal('Asia/Kolkata'),statuses:z.array(z.string().min(1).max(80)).min(1).max(60),sheetId:z.string().optional()}).parse(await body(request));if(new Set(data.statuses).size!==data.statuses.length)throw new AppError(400,'Statuses must be unique');if(data.sheetId)await accessibleSheet(user,data.sheetId);const statusKey=data.sheetId?`statuses:${data.sheetId}`:organizationSettingKey(user.organizationId,'statuses');const workspaceKey=organizationSettingKey(user.organizationId,'workspace');await db.setting.upsert({where:{key:statusKey},create:{key:statusKey,value:data.statuses},update:{value:data.statuses}});await db.setting.upsert({where:{key:workspaceKey},create:{key:workspaceKey,value:{name:data.name,timezone:data.timezone}},update:{value:{name:data.name,timezone:data.timezone}}});await db.organization.update({where:{id:user.organizationId},data:{name:data.name}});await audit(user.id,'UPDATE_SETTINGS','workspace');return ok({updated:true});
    }
    if(route==='users'&&method==='GET'){await requireUser(['SUPER_ADMIN']);return ok(await db.user.findMany({where:{organizationId:user.organizationId},select:{id:true,name:true,email:true,role:true,active:true,sheetAccess:{select:{sheetId:true}}}}));}
    if(route==='users'&&method==='POST'){
      await requireUser(['SUPER_ADMIN']);const data=z.object({name:z.string().min(2),email:z.email(),password:z.string().min(12).max(128),role:z.enum(['SUPER_ADMIN','MANAGER']),sheetIds:z.array(z.string())}).parse(await body(request));for(const sheetId of data.sheetIds)await accessibleSheet(user,sheetId);const u=await db.user.create({data:{organizationId:user.organizationId,name:data.name,email:data.email.toLowerCase(),passwordHash:passwordHash(data.password),role:data.role,sheetAccess:{create:data.sheetIds.map(sheetId=>({sheetId}))}}});await audit(user.id,'CREATE_USER','user',u.id);return ok(safeUser(u),201);
    }
    if(route==='jobs'&&method==='GET'){await requireUser(['SUPER_ADMIN']);return ok(await db.job.findMany({where:{organizationId:user.organizationId,status:{in:['PENDING','DEAD','PROCESSING']}},orderBy:{createdAt:'desc'},take:100}));}
    if(path[0]==='jobs'&&path[1]&&method==='POST'){await requireUser(['SUPER_ADMIN']);const job=await db.job.findFirst({where:{id:path[1],organizationId:user.organizationId}});if(!job||job.status!=='DEAD')throw new AppError(400,'Only dead-letter jobs can be retried');await db.job.update({where:{id:job.id},data:{status:'PENDING',attempts:0,runAt:new Date(),error:null}});await demoDrain(user.organizationId);return ok({queued:true});}
    if(route==='integrations/google/connect'){
      await requireUser(['SUPER_ADMIN']);const result=await startGoogleAuthorization(user,{url:p.get('sheet')||undefined,sheetId:p.get('sheetId')||undefined});return NextResponse.redirect(result.url);
    }
    if(route==='integrations/google/callback'){
      await requireUser(['SUPER_ADMIN']);
      const popup=await googleAuthorizationUsesPopup();let destination:URL;
      try{destination=new URL(await finishGoogleAuthorization(user,p));}
      catch(error){destination=new URL('/sheets',appUrl());destination.searchParams.set('google','error');destination.searchParams.set('message',error instanceof AppError?error.message:'Google authorization could not be completed. Please try again.');}
      if(popup)destination.pathname='/google-complete';
      return NextResponse.redirect(destination);
    }
    if(route==='events'){
      const encoder=new TextEncoder();let timer:ReturnType<typeof setInterval>;const stream=new ReadableStream({start(controller){controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));timer=setInterval(()=>{controller.enqueue(encoder.encode(`event: refresh\ndata: {"at":${Date.now()}}\n\n`));},15000);request.signal.addEventListener('abort',()=>{clearInterval(timer);try{controller.close();}catch{}});},cancel(){clearInterval(timer);}});return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'}});
    }
    throw new AppError(404,'API endpoint not found');
  }catch(error){
    if(error instanceof ZodError)return NextResponse.json({error:{code:'VALIDATION_ERROR',message:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}},{status:400});
    if(error instanceof AppError)return NextResponse.json({error:{code:error.code,message:error.message}},{status:error.status});
    const code=(error as {code?:string}).code;
    if(code==='P2002')return NextResponse.json({error:{code:'CONFLICT',message:'This record already exists. Check the email, phone number, or spreadsheet connection.'}},{status:409});
    if(code==='P2025')return NextResponse.json({error:{code:'NOT_FOUND',message:'Record not found'}},{status:404});
    const diagnostic=databaseFailure(error);
    console.error(JSON.stringify({event:'api_error',code:safeDatabaseErrorCode(error),type:error instanceof Error?error.name:'Error',...diagnostic}));
    if(diagnostic)return NextResponse.json({error:{code:'DATABASE_UNAVAILABLE',message:diagnostic.message},diagnostic},{status:503,headers:{'Cache-Control':'no-store'}});
    return NextResponse.json({error:{code:'INTERNAL_ERROR',message:'The operation could not be completed. Check the server configuration and try again.'}},{status:500});
  }
}
export {handler as GET,handler as POST,handler as PUT,handler as DELETE};
