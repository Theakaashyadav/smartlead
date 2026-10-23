import '../src/lib/config';
import { parseArgs } from 'node:util';
import { db } from '../src/lib/db';
import { deliveryBackfillLeads, queueDeliveryWriteback } from '../src/lib/delivery';
import { transaction, writebackLead } from '../src/lib/engine';
import { closePublicSheetEditor } from '../src/lib/public-sheet-editor';
import { AppError } from '../src/lib/security';

async function run(){
  const {values}=parseArgs({options:{sheet:{type:'string'},write:{type:'boolean'}}});
  if(!values.sheet)throw new AppError(400,'Choose a sheet with --sheet ID. Add --write to apply its queued delivery updates now.');
  const sheet=await db.sheet.findUniqueOrThrow({where:{id:values.sheet}});
  const leads=await deliveryBackfillLeads(sheet.id);
  let completed=0;
  for(const lead of leads){
    if(values.write){
      // Direct administrative backfill cannot be claimed by an older hosted
      // worker. It only writes delivery cells and never drains sending jobs.
      await writebackLead(lead.id,undefined,{deliveryOnly:true});
      completed++;
    }else{
      const job=await transaction(tx=>queueDeliveryWriteback(tx,lead.messages[0],'backfill-v1'));
      if(job.status==='COMPLETED')completed++;
    }
    console.log(JSON.stringify({event:'sheet_delivery_backfill',sheetId:sheet.id,completed,total:leads.length,mode:values.write?'write':'queue'}));
  }
  console.log(JSON.stringify({event:'sheet_delivery_backfill_complete',sheetId:sheet.id,successfulLeads:leads.length,completed}));
}
run().catch(error=>{
  console.error(error instanceof AppError?error.message:'Could not backfill delivery columns. Check database access, sheet sharing, and browser availability.');
  process.exitCode=1;
}).finally(async()=>{await closePublicSheetEditor();await db.$disconnect();});
