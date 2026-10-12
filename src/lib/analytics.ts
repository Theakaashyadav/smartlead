import type { Prisma, User } from '@/generated/postgres';
import { db } from './db';
import { employeeScope, leadScope, sheetScope } from './permissions';
import { CLOSED } from './validation';
import { organizationSettingKey } from './organizations';

export function leadFilters(params:URLSearchParams):Prisma.LeadWhereInput {
  const search=params.get('search')?.slice(0,100);
  const from=params.get('from'),to=params.get('to');
  const date:Prisma.DateTimeFilter={};
  if(from && !Number.isNaN(Date.parse(from)))date.gte=new Date(from.length===10?`${from}T00:00:00+05:30`:from);
  if(to && !Number.isNaN(Date.parse(to)))date.lte=new Date(to.length===10?`${to}T23:59:59.999+05:30`:to);
  return {
    ...(search?{OR:[{customerName:{contains:search}},{mobile:{contains:search}},{project:{contains:search}}]}:{}),
    ...(params.get('sheet')?{sheetId:params.get('sheet')!}:{}),
    ...(params.get('status')?{status:params.get('status')!}:{}),
    ...(params.get('project')?{project:params.get('project')!}:{}),
    ...(params.get('employee')?{assignments:{some:{employeeId:params.get('employee')!,active:true,isPrimary:true}}}:{}),
    ...(params.get('messageStatus')?{messages:{some:{status:params.get('messageStatus')!}}}:{}),
    ...(Object.keys(date).length?{leadDate:date}:{})
  };
}
export const leadInclude={sheet:{select:{id:true,name:true}},assignments:{where:{active:true},include:{employee:{select:{id:true,name:true,phone:true}}}},messages:{select:{id:true,status:true,uncertain:true},orderBy:{queuedAt:'desc' as const},take:1}};
export async function workspace(user:User,params:URLSearchParams) {
  const where:Prisma.LeadWhereInput={AND:[leadScope(user),leadFilters(params)]};
  const [leads,sheets,employees,senders,feedbackCount,messages,followups,jobs,credentials,settings]=await Promise.all([
    db.lead.findMany({where,include:{assignments:{where:{active:true},include:{employee:{select:{id:true,name:true,phone:true}}}},_count:{select:{feedback:true}}},orderBy:{createdAt:'desc'},take:10000}),
    db.sheet.findMany({where:sheetScope(user),include:{rule:{include:{recipients:true}},_count:{select:{leads:true}},syncLogs:{take:5,orderBy:{createdAt:'desc'}}},orderBy:{createdAt:'asc'}}),
    db.employee.findMany({where:employeeScope(user),include:{assignments:{where:{active:true,lead:where},include:{lead:{select:{status:true,lastFeedback:true,createdAt:true}}}},user:{select:{email:true}}}}),
    user.role==='SUPER_ADMIN'?db.sender.findMany({where:{organizationId:user.organizationId},select:{id:true,name:true,phone:true,provider:true,status:true,lastConnectedAt:true,lastError:true,createdAt:true}}):Promise.resolve([]),
    db.feedback.count({where:{lead:where}}),
    db.message.groupBy({by:['status'],where:{lead:where},_count:true}),
    db.followup.findMany({where:{lead:where,status:'PENDING'},include:{lead:{select:{id:true,customerName:true,project:true,mobile:true}},employee:{select:{id:true,name:true}}},orderBy:{scheduledAt:'asc'}}),
    user.role==='SUPER_ADMIN'?db.job.groupBy({by:['status'],where:{organizationId:user.organizationId},_count:true}):Promise.resolve([]),
    user.role==='SUPER_ADMIN'?db.googleCredential.findMany({where:{organizationId:user.organizationId},select:{id:true,label:true,type:true,createdAt:true}}):Promise.resolve([]),
    db.setting.findMany({where:{key:{in:['statuses','workspace'].map(key=>organizationSettingKey(user.organizationId,key))}}})
  ]);
  const counts=Object.fromEntries(messages.map(m=>[m.status,m._count]));
  const [total,assigned,converted,interested,sourceTotals,statusTotals,chartLeads,chartAssignments,chartFeedback]=await Promise.all([
    db.lead.count({where}),
    db.lead.count({where:{AND:[where,{assignments:{some:{active:true,isPrimary:true}}}]}}),
    db.lead.count({where:{AND:[where,{status:'Converted / Closed Won'}]}}),
    db.lead.count({where:{AND:[where,{status:{in:['Interested','Very Interested / Hot Lead','Negotiation']}}]}}),
    db.lead.groupBy({by:['sheetId'],where,_count:true}),
    db.lead.groupBy({by:['status'],where,_count:true}),
    db.lead.findMany({where:{AND:[where,{leadDate:{gte:new Date(Date.now()-14*86400000)}}]},select:{leadDate:true,status:true}}),
    db.assignment.findMany({where:{isPrimary:true,lead:where,assignedAt:{gte:new Date(Date.now()-14*86400000)}},select:{assignedAt:true}}),
    db.feedback.findMany({where:{lead:where,submittedAt:{gte:new Date(Date.now()-14*86400000)}},select:{submittedAt:true}})
  ]);
  const series:Record<string,{date:string;received:number;assigned:number;converted:number;feedback:number}>={};
  for(let i=13;i>=0;i--){const date=new Date(Date.now()-i*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});series[date]={date,received:0,assigned:0,converted:0,feedback:0};}
  for(const lead of chartLeads){const date=lead.leadDate.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});if(series[date]){series[date].received++;if(lead.status==='Converted / Closed Won')series[date].converted++;}}
  for(const assignment of chartAssignments){const date=assignment.assignedAt.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});if(series[date])series[date].assigned++;}
  for(const feedback of chartFeedback){const date=feedback.submittedAt.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});if(series[date])series[date].feedback++;}
  return {user:{id:user.id,name:user.name,email:user.email,role:user.role,twoFactor:!!user.totpSecret},sheets:sheets.map(s=>({...s,leads:sourceTotals.find(t=>t.sheetId===s.id)?._count||0,assigned:leads.filter(l=>l.sheetId===s.id&&l.assignments.length).length,converted:leads.filter(l=>l.sheetId===s.id&&l.status==='Converted / Closed Won').length})),employees:employees.map(e=>({...e,assigned:e.assignments.filter(a=>a.isPrimary).length,pending:e.assignments.filter(a=>a.isPrimary&&!CLOSED.includes(a.lead.status)).length,contacted:e.assignments.filter(a=>a.isPrimary&&a.lead.lastFeedback).length,converted:e.assignments.filter(a=>a.isPrimary&&a.lead.status==='Converted / Closed Won').length,interested:e.assignments.filter(a=>a.isPrimary&&['Interested','Very Interested / Hot Lead'].includes(a.lead.status)).length,assignments:undefined})),senders,credentials,followups,settings:Object.fromEntries(settings.map(s=>[s.key===organizationSettingKey(user.organizationId,'statuses')?'statuses':'workspace',s.value])),jobs:Object.fromEntries(jobs.map(j=>[j.status,j._count])),stats:{total,assigned,converted,interested,feedback:feedbackCount,notifications:Object.values(counts).reduce((s,n)=>s+n,0),submitted:(counts.SUBMITTED||0)+(counts.SENT||0)+(counts.DELIVERED||0)+(counts.READ||0),queued:(counts.QUEUED||0)+(counts.PROCESSING||0),failed:counts.FAILED||0,delivered:(counts.DELIVERED||0)+(counts.READ||0),read:counts.READ||0,followups:followups.length,conversionRate:total?Math.round(converted/total*1000)/10:0,counts,analyticsTruncated:total>10000},series:Object.values(series),statusDistribution:statusTotals.map(t=>({name:t.status,value:t._count})),recentLeads:await db.lead.findMany({where,include:leadInclude,orderBy:{createdAt:'desc'},take:8})};
}
