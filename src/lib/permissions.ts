import type { Prisma, User } from '@/generated/postgres';
import { db } from './db';
import { AppError } from './security';
export function sheetScope(user: User): Prisma.SheetWhereInput {
  const organizationId=user.organizationId;
  if (user.role === 'SUPER_ADMIN') return {organizationId};
  if (user.role === 'MANAGER') return {organizationId,access:{some:{userId:user.id}}};
  return {organizationId,leads:{some:{assignments:{some:{active:true,employee:{userId:user.id}}}}}};
}
export function leadScope(user: User): Prisma.LeadWhereInput {
  const sheet={organizationId:user.organizationId};
  if(user.role === 'SUPER_ADMIN') return {sheet};
  if(user.role === 'MANAGER') return {sheet:{...sheet,access:{some:{userId:user.id}}}};
  return {sheet,assignments:{some:{active:true,isPrimary:true,employee:{userId:user.id}}}};
}
export async function accessibleSheet(user: User, id: string) {
  const sheet = await db.sheet.findFirst({where:{AND:[{id},sheetScope(user)]}});
  if (!sheet) throw new AppError(404,'Sheet not found');
  return sheet;
}
export async function accessibleLead(user: User, id: string) {
  const lead = await db.lead.findFirst({where:{AND:[{id},leadScope(user)]},include:{sheet:true,assignments:{where:{active:true},include:{employee:true}},feedback:{orderBy:{submittedAt:'desc'}},messages:{orderBy:{queuedAt:'desc'},select:{id:true,status:true,queuedAt:true,submittedAt:true,providerMessageId:true,failureReason:true,attemptCount:true,uncertain:true,recipient:true}},followups:true}});
  if(!lead) throw new AppError(404,'Lead not found');
  return lead;
}
export function employeeScope(user: User): Prisma.EmployeeWhereInput {
  const organizationId=user.organizationId;
  if (user.role === 'SUPER_ADMIN') return {organizationId};
  if (user.role === 'EXECUTIVE') return {organizationId,userId:user.id};
  return {organizationId,recipients:{some:{rule:{sheet:{organizationId,access:{some:{userId:user.id}}}}}}};
}
