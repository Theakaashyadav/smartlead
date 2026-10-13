import './lib/config';
import { startWorkerService } from './lib/worker-service';

const service=startWorkerService({closeDatabase:true});
const stop=()=>service.stop();
process.once('SIGTERM',stop);process.once('SIGINT',stop);
service.done.then(({failed})=>{if(failed)process.exitCode=1;}).finally(()=>{
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
});
