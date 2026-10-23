import { z } from 'zod';
import { db } from './db';
import { opaqueToken, passwordHash } from './security';
import { phoneSchema, pinSchema } from './validation';

// Preserve the original installation's records and settings during upgrades.
export const LEGACY_ORGANIZATION = 'legacy';
export const organizationSettingKey = (organizationId:string, key:string) =>
  organizationId === LEGACY_ORGANIZATION ? key : `organization:${organizationId}:${key}`;

const ownerSchema = z.object({
  name:z.string().trim().min(2).max(100),
  organizationName:z.string().trim().min(2).max(100),
});
export const registrationSchema = z.union([
  ownerSchema.extend({phone:phoneSchema,pin:pinSchema}),
  ownerSchema.extend({
    email:z.email().max(254).transform(value=>value.toLowerCase()),
    password:z.string().min(12).max(128),
  }),
]);

export async function registerOrganization(input:unknown) {
  const data=registrationSchema.parse(input);
  const credentials='phone' in data
    ? {phone:data.phone,pinHash:passwordHash(data.pin),passwordHash:passwordHash(opaqueToken())}
    : {email:data.email,passwordHash:passwordHash(data.password)};
  const organization=await db.organization.create({data:{
    name:data.organizationName,
    users:{create:{name:data.name,...credentials,role:'SUPER_ADMIN'}},
  },include:{users:true}});
  return organization.users[0];
}
