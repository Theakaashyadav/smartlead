import '../src/lib/config';
import { db } from '../src/lib/db';
import { feedbackBaseURL } from '../src/lib/feedback-url';
import { refreshSimpleQueuedMessages } from '../src/lib/engine';

async function run(){
  await feedbackBaseURL(db,true);
  const sheets=await db.sheet.findMany({where:{connectionType:{startsWith:'SIMPLE_'},leads:{some:{messages:{some:{status:'QUEUED'}}}}},select:{id:true}});
  for(const sheet of sheets)await refreshSimpleQueuedMessages(sheet.id,undefined,true);
  console.log(`Refreshed queued feedback links for ${sheets.length} sheet(s). Existing feedback tokens are preserved. No messages were sent.`);
}
run().catch(error=>{console.error(error instanceof Error?error.message:'Could not refresh feedback links');process.exitCode=1;}).finally(()=>db.$disconnect());
