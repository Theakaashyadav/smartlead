import '../src/lib/config';
import { db } from '../src/lib/db';

async function run(){
  const live={sheet:{connectionType:{not:'DEMO'}}};
  const [leads,assignments,messages,feedback,followups,tokens,links,jobs,connections,writebacks,deliveries]=await Promise.all([
    db.lead.count({where:live}),
    db.assignment.count({where:{lead:live}}),
    db.message.count({where:{lead:live}}),
    db.feedback.count({where:{lead:live}}),
    db.followup.count({where:{lead:live}}),
    db.feedbackToken.count({where:{assignment:{lead:live}}}),
    db.feedbackLink.count(),
    db.job.groupBy({by:['status'],_count:true}),
    Promise.all([db.organization.count(),db.user.count(),db.sheet.count(),db.sender.count(),db.employee.count()]),
    db.lead.groupBy({by:['writebackStatus'],where:live,_count:true}),
    db.message.groupBy({by:['status','uncertain'],where:{lead:live},_count:true}),
  ]);
  console.log(JSON.stringify({
    policy:process.env.LEAD_STORAGE_MODE==='permanent'?'permanent':'temporary',
    temporaryLeadRecords:{leads,assignments,messages,feedback,followups,tokens},
    expiringLinkReferences:links,
    jobs:Object.fromEntries(jobs.map(job=>[job.status,job._count])),
    sheetUpdates:Object.fromEntries(writebacks.map(group=>[group.writebackStatus,group._count])),
    deliveryStates:deliveries.map(group=>({status:group.status,uncertain:group.uncertain,count:group._count})),
    permanentConnections:Object.fromEntries(['organizations','users','sheets','whatsappAccounts','recipients'].map((key,index)=>[key,connections[index]])),
  },null,2));
}
run().catch(()=>{console.error('Unable to inspect lead storage. Check the SmartLead database configuration and network access.');process.exitCode=1;}).finally(()=>db.$disconnect());
