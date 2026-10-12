import { z } from 'zod';
import { db } from './db';
import { passwordHash } from './security';

// Preserve the original installation's records and settings during upgrades.
export const LEGACY_ORGANIZATION = 'legacy';
export const organizationSettingKey = (organizationId:string, key:string) =>
  organizationId === LEGACY_ORGANIZATION ? key : `organization:${organizationId}:${key}`;

export const registrationSchema = z.object({
  name:z.string().trim().min(2).max(100),
  organizationName:z.string().trim().min(2).max(100),
  email:z.email().max(254).transform(value=>value.toLowerCase()),
  password:z.string().min(12).max(128),
});

export async function registerOrganization(input:unknown) {
  const data=registrationSchema.parse(input);
  const organization=await db.organization.create({data:{
    name:data.organizationName,
    users:{create:{name:data.name,email:data.email,passwordHash:passwordHash(data.password),role:'SUPER_ADMIN'}},
  },include:{users:true}});
  return organization.users[0];
}
