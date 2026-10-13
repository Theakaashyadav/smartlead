import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({start:vi.fn(),mkdir:vi.fn()}));
vi.mock('@/lib/worker-service',()=>({startWorkerService:mocks.start}));
vi.mock('node:fs/promises',()=>({mkdir:mocks.mkdir}));
import { hostedDataDirectory, startHostedWorker, stopHostedWorker } from '@/lib/hosted-worker';

beforeEach(()=>{
  for(const key of ['SMARTLEAD_DATA_DIR','WHATSAPP_PROFILE_DIR','WHATSAPP_SESSION_DIR','WHATSAPP_REMOTE_AUTH_DIR','PUPPETEER_CACHE_DIR','WHATSAPP_LOGIN_MODE'])vi.stubEnv(key,'');
  mocks.mkdir.mockReset().mockResolvedValue(undefined);mocks.start.mockReset();
  mocks.start.mockImplementation(()=>{
    let finish!:(value:{failed:boolean;reason?:string})=>void;const done=new Promise<{failed:boolean;reason?:string}>(resolve=>{finish=resolve;});
    return {stop:vi.fn(()=>finish({failed:false})),done,fail:(reason?:string)=>finish({failed:true,reason})};
  });
});
afterEach(async()=>{await stopHostedWorker();vi.useRealTimers();vi.unstubAllEnvs();});
describe('embedded hosted worker',()=>{
  it('defaults to browserless QR login and respects an explicitly configured transport',async()=>{
    await startHostedWorker();expect(process.env.WHATSAPP_LOGIN_MODE).toBe('socket');
    await stopHostedWorker();vi.stubEnv('WHATSAPP_LOGIN_MODE','background');
    await startHostedWorker();expect(process.env.WHATSAPP_LOGIN_MODE).toBe('background');
  });
  it('starts only one worker even if server initialization is repeated',async()=>{
    await startHostedWorker();await startHostedWorker();expect(mocks.start).toHaveBeenCalledOnce();
  });
  it('restarts a failed service without restarting the HTTP server',async()=>{
    vi.useFakeTimers();await startHostedWorker();mocks.start.mock.results[0].value.fail();
    await vi.advanceTimersByTimeAsync(1000);expect(mocks.start).toHaveBeenCalledTimes(2);
  });
  it('keeps Hostinger profiles outside replaceable published versions',()=>{
    const domain=path.resolve('host','domains','smartlead.example.com');
    expect(hostedDataDirectory(path.join(domain,'hbuilds','versions','release-id','nodejs'))).toBe(path.join(domain,'smartlead-data'));
    vi.stubEnv('SMARTLEAD_DATA_DIR','data');
    expect(hostedDataDirectory(path.join(domain,'hbuilds','versions','release-id','nodejs'))).toBe(path.join(domain,'data'));
    vi.stubEnv('SMARTLEAD_DATA_DIR',path.join(domain,'custom-data'));
    expect(hostedDataDirectory(path.join(domain,'hbuilds','current','nodejs'))).toBe(path.join(domain,'custom-data'));
  });
  it('waits five minutes before retrying browser failures on a constrained hosting account',async()=>{
    vi.useFakeTimers();await startHostedWorker();mocks.start.mock.results[0].value.fail('BROWSER_START_FAILED');
    await vi.advanceTimersByTimeAsync(299999);expect(mocks.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);expect(mocks.start).toHaveBeenCalledTimes(2);
  });
});
