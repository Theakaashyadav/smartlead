import '../src/lib/config';
import { db, databaseHealth } from '../src/lib/db';
import { workerHeartbeatFresh } from '../src/lib/worker-status';

async function check(){
  await databaseHealth();
  const worker=await db.setting.findUnique({where:{key:'simple:worker'}});
  if(!workerHeartbeatFresh(worker?.value))throw new Error('Worker heartbeat is stale');
  console.log('SmartLead worker is online.');
}
check().catch(()=>{console.error('SmartLead worker is offline. Check the worker runtime logs.');process.exitCode=1;}).finally(()=>db.$disconnect());
