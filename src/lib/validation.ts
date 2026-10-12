import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
export const STATUSES = ['New','Not Contacted','Call Attempted','No Answer','Switched Off','Not Reachable','Connected','Interested','Very Interested / Hot Lead','Follow-up Required','Site Visit Scheduled','Site Visit Completed','Negotiation','Booking Confirmed','Converted / Closed Won','Not Interested','Invalid Number','Duplicate Lead','Lost / Closed Lost'];
export const CLOSED = ['Converted / Closed Won','Lost / Closed Lost','Not Interested','Invalid Number','Duplicate Lead'];
export const MODES = ['SINGLE','ROUND_ROBIN','ALL','MANUAL','WEIGHTED','CAPACITY'] as const;
export const phoneSchema = z.string().transform((v,ctx)=>{
  const p = parsePhoneNumberFromString(v,'IN');
  if (!p?.isValid()) {ctx.addIssue({code:'custom',message:'Enter a valid Indian or international phone number'}); return z.NEVER;}
  return p.number;
});
export const loginSchema = z.object({email:z.email().max(254),password:z.string().min(1).max(128),code:z.string().optional()});
export const feedbackSchema = z.object({status:z.string().min(1).max(80),remarks:z.string().trim().min(3,'Add at least 3 characters of feedback').max(5000),interest:z.enum(['Hot','Warm','Cold','Not Interested']).optional(),callOutcome:z.string().max(200).optional(),contactMethod:z.string().max(40).optional(),siteVisitAt:z.iso.datetime().nullish(),expectedBudget:z.string().max(100).optional(),nextFollowupAt:z.iso.datetime().nullish(),version:z.number().int().nonnegative()});
export const employeeSchema = z.object({name:z.string().min(2).max(100),phone:phoneSchema,department:z.string().max(100).default('Sales'),role:z.string().max(80).default('Sales Executive'),projects:z.array(z.string().max(100)).default([]),dailyLimit:z.number().int().min(1).max(1000).default(50),capacity:z.number().int().min(1).max(10000).default(100),active:z.boolean().default(true),remarks:z.string().max(2000).default(''),email:z.email().optional(),password:z.string().min(12).max(128).optional()});
export const ruleSchema = z.object({mode:z.enum(MODES),enabled:z.boolean(),senderId:z.string().nullable(),recipients:z.array(z.object({employeeId:z.string(),weight:z.number().int().min(0).max(100).default(0)})).max(100),template:z.string().min(10).max(4000),metaTemplate:z.string().max(100).nullish(),metaLanguage:z.string().max(20).default('en')}).superRefine((v,ctx)=>{
  if(v.mode !== 'MANUAL' && !v.recipients.length) ctx.addIssue({code:'custom',message:'Select at least one authorized recipient',path:['recipients']});
  if(v.mode==='SINGLE' && v.recipients.length!==1) ctx.addIssue({code:'custom',message:'Single mode requires exactly one recipient',path:['recipients']});
  if(v.mode==='WEIGHTED' && v.recipients.reduce((s,r)=>s+r.weight,0)!==100) ctx.addIssue({code:'custom',message:'Weights must total 100%',path:['recipients']});
  if(new Set(v.recipients.map(r=>r.employeeId)).size!==v.recipients.length) ctx.addIssue({code:'custom',message:'Recipients must be unique'});
});
export const INPUT_FIELDS = ['leadId','leadDate','customerName','mobile','email','project','location','budget','source','requirement'];
export const MANAGED: Record<string,string> = {assignedEmployee:'SmartLead Owner',assignedPhone:'SmartLead WhatsApp',status:'SmartLead Status',feedback:'SmartLead Feedback',nextFollowupAt:'SmartLead Follow-up',lastContactAt:'SmartLead Last Contact',sentStatus:'SmartLead Sent Status',sentAt:'SmartLead Sent At',deliveryStatus:'SmartLead Delivery',updatedAt:'SmartLead Updated At',updatedBy:'SmartLead Updated By'};
export const sheetSchema = z.object({name:z.string().min(2).max(120),project:z.string().min(1).max(120),spreadsheetId:z.string().min(3).max(200),worksheetId:z.number().int().nonnegative(),worksheetName:z.string().min(1).max(100),credentialId:z.string().nullable().optional(),connectionType:z.enum(['OAUTH','SERVICE_ACCOUNT','DEMO']),columnMapping:z.record(z.string(),z.string()),managedColumnsApproved:z.boolean(),syncInterval:z.number().int().min(60).max(86400).default(180)}).superRefine((v,ctx)=>{
  if(!v.columnMapping.customerName || !v.columnMapping.mobile) ctx.addIssue({code:'custom',message:'Map customer name and mobile columns'});
  if(!v.columnMapping.leadId && !v.managedColumnsApproved) ctx.addIssue({code:'custom',message:'Map a stable Lead ID or approve adding a SmartLead ID column'});
  const mapped = Object.values(v.columnMapping).filter(Boolean);
  if(new Set(mapped).size!==mapped.length) ctx.addIssue({code:'custom',message:'Each field must map to a different column'});
  if(Object.keys(v.columnMapping).some(k=>!INPUT_FIELDS.includes(k) && !Object.keys(MANAGED).includes(k))) ctx.addIssue({code:'custom',message:'Unknown mapped field'});
});
export const DEFAULT_TEMPLATE = '*NEW LEAD ASSIGNED*\n\n*Customer:* {{customer_name}}\n*Phone:* {{mobile_number}}\n*Project:* {{project_name}}\n*Location:* {{location}}\n*Budget:* {{budget}}\n*Source:* {{lead_source}}\n*Received:* {{lead_date}}\n*Assigned to:* {{assigned_employee}}\n\n*Update status & feedback*\n{{feedback_link}}\n\nSmartLead · Every lead, accounted for.';
export const VARIABLES = ['customer_name','mobile_number','project_name','location','budget','lead_source','assigned_employee','lead_date','feedback_link'];
export function validateTemplate(template: string) {
  const vars = [...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(v=>v[1]);
  return vars.includes('feedback_link') && vars.every(v=>VARIABLES.includes(v));
}
