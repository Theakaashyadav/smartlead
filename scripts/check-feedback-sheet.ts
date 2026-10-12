import '../src/lib/config';
import { db } from '../src/lib/db';
import { publicCSV, PublicSheetsProvider } from '../src/lib/public-sheets';
import { outputColumns } from '../src/lib/public-sheet-editor';
import { decrypt } from '../src/lib/security';
async function run(){
  for(const sheet of await db.sheet.findMany({where:{connectionType:'SIMPLE_PUBLIC'}})){
    const lead=await db.lead.findFirstOrThrow({where:{sheetId:sheet.id,sourceDeleted:false,assignments:{some:{active:true,isPrimary:true}}},orderBy:{sourceRow:'asc'}});
    const csv=await publicCSV(sheet.spreadsheetId,sheet.worksheetId);
    const rows=await new PublicSheetsProvider().read(sheet);
    const found=rows.filter(row=>row.stableId===lead.stableSourceId);
    const stored=await db.lead.findMany({where:{sheetId:sheet.id,sourceDeleted:false},include:{assignments:{where:{active:true,isPrimary:true},include:{employee:true}}}});
    const columns=outputColumns(csv);
    const verified=stored.filter(l=>{const row=rows.find(r=>r.stableId===l.stableSourceId);const values={status:l.status,assignedEmployee:l.assignments[0]?.employee.name||'',feedback:l.lastFeedback||''};return row&&columns.every(c=>(csv[row.row-1]?.[c.index]||'')===values[c.field as keyof typeof values]);}).length;
    console.log(JSON.stringify({verifiedSourceOutputs:verified,leads:stored.length,upgradeJobs:await db.job.groupBy({by:['status'],where:{key:{startsWith:'writeback:feedback-upgrade:'}},_count:true}),errors:await db.job.groupBy({by:['error'],where:{key:{startsWith:'writeback:feedback-upgrade:'},error:{not:null}},_count:true})}));
    const owner=await db.assignment.findFirst({where:{leadId:lead.id,active:true,isPrimary:true},include:{employee:true}});
    const desired={status:lead.status,assignedEmployee:owner?.employee.name||'',feedback:lead.lastFeedback||''};
    const snapshot=(lead.managedSnapshot||{}) as Record<string,string>;
    console.log(JSON.stringify({sheetId:sheet.id,leadId:lead.id,storedRow:lead.sourceRow,foundRows:found.map(r=>r.row),sourceLeads:rows.length,preserved:stored.filter(l=>{const row=rows.find(r=>r.stableId===l.stableSourceId);return row&&row.values.customerName===l.customerName&&JSON.stringify(row.questions)===JSON.stringify((l.sourceData as {questions?:unknown[]}|null)?.questions);}).length,width:csv[0].length,columns:outputColumns(csv).map(c=>({field:c.field,label:c.label,index:c.index,missing:c.missing,actualLength:(csv[found[0]?.row-1]?.[c.index]||'').length,expectedLength:(snapshot[c.field]||'').length,desiredLength:desired[c.field as keyof typeof desired].length,actualEqualsExpected:(csv[found[0]?.row-1]?.[c.index]||'')===(snapshot[c.field]||''),actualEqualsDesired:(csv[found[0]?.row-1]?.[c.index]||'')===desired[c.field as keyof typeof desired]}))}));
    if(process.argv.includes('--local')){
      const message=await db.message.findFirstOrThrow({where:{lead:{sheetId:sheet.id},status:'QUEUED'}});
      const body=decrypt(message.encryptedBody);const token=body.match(/\/feedback\/([\w.-]+)/)?.[1];
      if(!token)throw new Error('Private feedback token is missing.');
      const response=await fetch(`http://127.0.0.1:3000/api/feedback/${token}`);const result=await response.json();
      console.log(JSON.stringify({feedbackHTTP:response.status,simple:result.data?.simple,questionCount:result.data?.lead.questions?.length,sameLead:result.data?.lead.id===message.leadId,messageHasQuestions:body.includes('Q.1 - '),messageHasRequestedFormat:body.startsWith('Hello\n\nYou got a new lead from '),writeback:await db.lead.groupBy({by:['writebackStatus'],where:{sheetId:sheet.id},_count:true}),sendingEnabled:(await db.distributionRule.findUnique({where:{sheetId:sheet.id}}))?.enabled,recipients:await db.ruleRecipient.count({where:{rule:{sheetId:sheet.id}}})}));
    }
  }
}
run().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());
