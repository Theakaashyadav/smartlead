import { db } from './db';
import { leadScope } from './permissions';
import { leadFilters } from './analytics';
import type { User } from '@/generated/postgres';
export async function reportRows(user:User,params:URLSearchParams) {
  const where={AND:[leadScope(user),leadFilters(params)]};
  const kind=params.get('type')||'leads';
  if(kind==='notifications')return (await db.message.findMany({where:{lead:where},include:{lead:{select:{customerName:true}},sender:{select:{name:true,provider:true}}},orderBy:{queuedAt:'desc'},take:10000})).map(m=>({'Lead':m.lead.customerName,'Recipient':m.recipient,'Sender':m.sender.name,'Provider':m.sender.provider,'Status':m.status,'Attempts':m.attemptCount,'Uncertain':m.uncertain?'Yes':'No','Queued':m.queuedAt.toISOString(),'Submitted':m.submittedAt?.toISOString()||'','Message ID':m.providerMessageId||'','Failure':m.failureReason||''}));
  if(kind==='feedback')return (await db.feedback.findMany({where:{lead:where},include:{lead:{select:{customerName:true}},assignment:{include:{employee:{select:{name:true}}}}},orderBy:{submittedAt:'desc'},take:10000})).map(f=>({'Lead':f.lead.customerName,'Employee':f.assignment.employee.name,'Status':f.status,'Interest':f.interest||'','Feedback':f.remarks,'Follow-up':f.nextFollowupAt?.toISOString()||'','Submitted':f.submittedAt.toISOString()}));
  if(kind==='followups')return (await db.followup.findMany({where:{lead:where},include:{lead:{select:{customerName:true,project:true}},employee:{select:{name:true}}},take:10000})).map(f=>({'Lead':f.lead.customerName,'Project':f.lead.project,'Employee':f.employee.name,'Scheduled':f.scheduledAt.toISOString(),'Status':f.status,'Notes':f.notes||''}));
  const leads=await db.lead.findMany({where,include:{sheet:{select:{name:true}},assignments:{where:{active:true,isPrimary:true},include:{employee:{select:{name:true,phone:true}}}}},orderBy:{createdAt:'desc'},take:10000});
  if(['sheets','employees','status','conversion'].includes(kind)){
    const groups:Record<string,{total:number;converted:number;feedback:number}>={};
    for(const l of leads){const key=kind==='sheets'?l.sheet.name:kind==='employees'?l.assignments[0]?.employee.name||'Unassigned':l.status;groups[key]??={total:0,converted:0,feedback:0};groups[key].total++;if(l.status==='Converted / Closed Won')groups[key].converted++;if(l.lastFeedback)groups[key].feedback++;}
    return Object.entries(groups).map(([name,v])=>({'Group':name,'Leads':v.total,'Converted':v.converted,'With feedback':v.feedback,'Conversion rate':`${Math.round(v.converted/v.total*1000)/10}%`}));
  }
  return leads.map(l=>({'Lead ID':l.id,'Date':l.leadDate.toISOString(),'Customer':l.customerName,'Mobile':l.mobile,'Email':l.email||'','Project':l.project,'Sheet':l.sheet.name,'Owner':l.assignments[0]?.employee.name||'Unassigned','Owner WhatsApp':l.assignments[0]?.employee.phone||'','Status':l.status,'Feedback':l.lastFeedback||'','Follow-up':l.nextFollowupAt?.toISOString()||'','Writeback':l.writebackStatus}));
}
// Protect spreadsheet consumers against formulas in customer-controlled values.
export const safeCell=(value:unknown)=>typeof value==='string'&&/^[\s]*[=+\-@]/.test(value)?`'${value}`:value;
export function csv(rows:Record<string,unknown>[]) {
  const columns=Object.keys(rows[0]||{});
  const quote=(v:unknown)=>`"${String(safeCell(v)??'').replaceAll('"','""')}"`;
  return '\uFEFF'+[columns.map(quote).join(','),...rows.map(r=>columns.map(c=>quote(r[c])).join(','))].join('\r\n');
}
