import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({setup:vi.fn(),worker:vi.fn()}));
vi.mock('@/lib/admin-phone-setup',()=>({runAdminPhoneSetup:mocks.setup}));
vi.mock('@/lib/hosted-worker',()=>({startHostedWorker:mocks.worker}));
import { register } from '@/instrumentation';

beforeEach(()=>{
  vi.stubEnv('NEXT_RUNTIME','nodejs');vi.stubEnv('NODE_ENV','production');vi.stubEnv('NEXT_PHASE','phase-production-server');
  vi.stubEnv('SMARTLEAD_EXTERNAL_WORKER','true');vi.stubEnv('ADMIN_PHONE_SETUP','false');
  mocks.setup.mockReset().mockResolvedValue({status:'complete'});mocks.worker.mockReset().mockResolvedValue(undefined);
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('production server startup',()=>{
  it('does not run recovery without an explicit environment setting',async()=>{
    await register();expect(mocks.setup).not.toHaveBeenCalled();expect(mocks.worker).not.toHaveBeenCalled();
  });
  it('starts the embedded worker normally when administrator setup is disabled',async()=>{
    vi.stubEnv('SMARTLEAD_EXTERNAL_WORKER','false');await register();
    expect(mocks.setup).not.toHaveBeenCalled();expect(mocks.worker).toHaveBeenCalledOnce();
  });
  it('runs recovery on the web server even when a separate process owns the worker',async()=>{
    vi.stubEnv('ADMIN_PHONE_SETUP','true');await register();expect(mocks.setup).toHaveBeenCalledOnce();expect(mocks.worker).not.toHaveBeenCalled();
  });
  it('finishes recovery before starting the embedded worker',async()=>{
    vi.stubEnv('ADMIN_PHONE_SETUP','true');vi.stubEnv('SMARTLEAD_EXTERNAL_WORKER','false');
    await register();expect(mocks.setup.mock.invocationCallOrder[0]).toBeLessThan(mocks.worker.mock.invocationCallOrder[0]);
  });
  it.each([{NEXT_PHASE:'phase-production-build'},{NODE_ENV:'development'},{NEXT_RUNTIME:'edge'}])('never recovers accounts in %j',async overrides=>{
    vi.stubEnv('ADMIN_PHONE_SETUP','true');for(const [key,value]of Object.entries(overrides))vi.stubEnv(key,value);
    await register();expect(mocks.setup).not.toHaveBeenCalled();expect(mocks.worker).not.toHaveBeenCalled();
  });
  it('keeps startup available and redacts unexpected setup errors',async()=>{
    vi.stubEnv('ADMIN_PHONE_SETUP','true');vi.stubEnv('SMARTLEAD_EXTERNAL_WORKER','false');
    mocks.setup.mockRejectedValueOnce(new Error('private database credentials'));
    const output=vi.spyOn(console,'error').mockImplementation(()=>{});
    await register();expect(mocks.worker).toHaveBeenCalledOnce();expect(output.mock.calls.flat().join(' ')).not.toContain('private database credentials');
  });
});
