import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({probe:vi.fn(),schedule:vi.fn(),drain:vi.fn(),detach:vi.fn(),closeEditor:vi.fn()}));
vi.mock('@/lib/worker-browser',async importOriginal=>({...await importOriginal<typeof import('@/lib/worker-browser')>(),verifyWorkerBrowser:mocks.probe}));
vi.mock('@/lib/engine',()=>({scheduleJobs:mocks.schedule,drainJobs:mocks.drain}));
vi.mock('@/lib/whatsapp-native',()=>({detachNativeWhatsApp:mocks.detach}));
vi.mock('@/lib/public-sheet-editor',()=>({closePublicSheetEditor:mocks.closeEditor}));
import { db, databaseHealth } from '@/lib/db';
import { startWorkerService } from '@/lib/worker-service';
import { WorkerBrowserError } from '@/lib/worker-browser';
import { workerHeartbeatFresh } from '@/lib/worker-status';
import { WorkerLease } from '@/lib/worker-lease';

const services:ReturnType<typeof startWorkerService>[]=[];
beforeEach(async()=>{
  await db.setting.deleteMany({where:{key:{in:['simple:worker','simple:worker-error']}}});
  vi.stubEnv('DEMO_MODE','false');
  vi.stubEnv('WHATSAPP_LOGIN_MODE','background');
  for(const mock of Object.values(mocks))mock.mockReset().mockResolvedValue(undefined);
});
afterEach(async()=>{for(const service of services.splice(0)){service.stop();await service.done;}vi.unstubAllEnvs();});
afterAll(()=>db.$disconnect());
describe('worker embedded in the website process',()=>{
  it('keeps the send lane running while a sheet download is still in progress',async()=>{
    vi.stubEnv('WHATSAPP_LOGIN_MODE','socket');
    let finish!:()=>void;const sheetRead=new Promise<void>(resolve=>{finish=resolve;});
    let sends=0;let reading=false;
    mocks.drain.mockImplementation(async(_limit,_delay,_organization,_running,types:string[])=>{
      if(types?.includes('SYNC')){reading=true;await sheetRead;}
      if(types?.includes('SEND'))sends++;
      return 0;
    });
    const service=startWorkerService();services.push(service);
    try{
      await vi.waitFor(()=>expect(reading).toBe(true));
      await vi.waitFor(()=>expect(sends).toBeGreaterThanOrEqual(2));
    }finally{service.stop();finish();await service.done;}
  });
  it('runs sheet polling and sending without probing Chromium in socket mode',async()=>{
    vi.stubEnv('WHATSAPP_LOGIN_MODE','socket');
    mocks.probe.mockRejectedValue(new WorkerBrowserError('BROWSER_HOST_CAPACITY','Chromium is unavailable.'));
    const service=startWorkerService();services.push(service);
    await vi.waitFor(()=>expect(mocks.drain).toHaveBeenCalled());
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(workerHeartbeatFresh((await db.setting.findUniqueOrThrow({where:{key:'simple:worker'}})).value)).toBe(true);
  });
  it('reserves ownership during the browser probe without claiming that WhatsApp is online',async()=>{
    let finishProbe!:()=>void;mocks.probe.mockImplementation(()=>new Promise<void>(resolve=>{finishProbe=resolve;}));
    const service=startWorkerService();services.push(service);
    await vi.waitFor(()=>expect(mocks.probe).toHaveBeenCalledOnce());
    const heartbeat=await db.setting.findUniqueOrThrow({where:{key:'simple:worker'}});
    expect(workerHeartbeatFresh(heartbeat.value)).toBe(false);
    expect(await new WorkerLease('overlapping-release').acquire()).toBe(false);
    finishProbe();
    await vi.waitFor(async()=>expect(workerHeartbeatFresh((await db.setting.findUniqueOrThrow({where:{key:'simple:worker'}})).value)).toBe(true));
    service.stop();expect(await service.done).toMatchObject({failed:false});
    expect(workerHeartbeatFresh((await db.setting.findUniqueOrThrow({where:{key:'simple:worker'}})).value)).toBe(false);
    await databaseHealth();
  });
  it('records browser failures for hosted diagnostics and leaves the HTTP database usable',async()=>{
    mocks.probe.mockRejectedValue(new WorkerBrowserError('BROWSER_HOST_CAPACITY','The hosting account cannot start Chromium.'));
    const service=startWorkerService();services.push(service);
    expect(await service.done).toMatchObject({failed:true,reason:'BROWSER_HOST_CAPACITY'});
    expect((await db.setting.findUniqueOrThrow({where:{key:'simple:worker-error'}})).value).toMatchObject({reason:'BROWSER_HOST_CAPACITY'});
    expect(mocks.schedule).not.toHaveBeenCalled();await databaseHealth();
  });
});
