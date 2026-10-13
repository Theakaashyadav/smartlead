import { afterEach, describe, expect, it, vi } from 'vitest';
const start=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/hosted-worker',()=>({startHostedWorker:start}));
import { register } from '@/instrumentation';

afterEach(()=>{vi.unstubAllEnvs();start.mockReset();});
function production(){vi.stubEnv('NODE_ENV','production');vi.stubEnv('NEXT_RUNTIME','nodejs');vi.stubEnv('NEXT_PHASE','phase-production-server');vi.stubEnv('SMARTLEAD_EXTERNAL_WORKER','');}
describe('standalone worker startup',()=>{
  it('starts the worker from the production Next.js server hook',async()=>{production();await register();expect(start).toHaveBeenCalledOnce();});
  it('does not start a worker while building or in the edge runtime',async()=>{
    production();vi.stubEnv('NEXT_PHASE','phase-production-build');await register();
    vi.stubEnv('NEXT_PHASE','phase-production-server');vi.stubEnv('NEXT_RUNTIME','edge');await register();expect(start).not.toHaveBeenCalled();
  });
  it('leaves the worker to the process supervisor or Docker when configured',async()=>{production();vi.stubEnv('SMARTLEAD_EXTERNAL_WORKER','true');await register();expect(start).not.toHaveBeenCalled();});
  it('does not start production automation during local development',async()=>{production();vi.stubEnv('NODE_ENV','development');await register();expect(start).not.toHaveBeenCalled();});
});
