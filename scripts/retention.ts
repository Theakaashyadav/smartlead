import '../src/lib/config';
import { db } from '../src/lib/db';
import { CLOSED } from '../src/lib/validation';
import { encrypt } from '../src/lib/security';
import { transaction } from '../src/lib/engine';
async function run(){
  const days=Number(process.env.RETENTION_DAYS||365);
  if(!Number.isInteger(days)||days<30)throw new Error('RETENTION_DAYS must be an integer of at least 30');
  const where={redactedAt:null,status:{in:CLOSED},updatedAt:{lt:new Date(Date.now()-days*86400000)}};
  const count=await db.lead.count({where});
  console.log(`${count} closed leads are eligible for application-data redaction after ${days} days.`);
  if(!process.argv.includes('--apply')){console.log('Preview only. Run npm run retention -- --apply to redact eligible application records. Source spreadsheets are unchanged.');return;}
  for(const lead of await db.lead.findMany({where,select:{id:true}}))await transaction(async tx=>{
    await tx.feedbackToken.updateMany({where:{assignment:{leadId:lead.id}},data:{revokedAt:new Date()}});
    await tx.assignment.updateMany({where:{leadId:lead.id},data:{active:false}});
    await tx.feedback.updateMany({where:{leadId:lead.id},data:{remarks:'[Removed by data retention]',callOutcome:null,expectedBudget:null}});
    await tx.followup.updateMany({where:{leadId:lead.id},data:{notes:null,status:'ARCHIVED'}});
    await tx.message.updateMany({where:{leadId:lead.id},data:{encryptedBody:encrypt('[Removed by data retention]')}});
    await tx.lead.update({where:{id:lead.id},data:{customerName:'[Archived lead]',mobile:'',email:null,location:null,budget:null,requirement:null,source:null,sourceData:{},lastFeedback:null,managedSnapshot:{},redactedAt:new Date(),version:{increment:1}}});
    await tx.auditLog.create({data:{action:'RETENTION_REDACTION',entityType:'lead',entityId:lead.id}});
  });
  console.log(`Redacted ${count} application records; source-identity tombstones prevent re-import.`);
}
run().then(()=>db.$disconnect()).catch(async e=>{console.error(e.message);await db.$disconnect();process.exitCode=1;});
