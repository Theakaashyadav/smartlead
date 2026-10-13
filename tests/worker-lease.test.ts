import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { WorkerLease, WORKER_KEY } from '@/lib/worker-lease';
import { workerHeartbeatFresh } from '@/lib/worker-status';

beforeEach(() => db.setting.deleteMany({ where: { key: WORKER_KEY } }));
afterAll(() => db.$disconnect());
describe('hosted worker ownership', () => {
  it('allows only one of two simultaneous workers to acquire an empty database', async () => {
    const now = Date.now();
    const workers=[new WorkerLease('one'),new WorkerLease('two')];
    const results = await Promise.all(workers.map(worker=>worker.acquire(now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(workerHeartbeatFresh((await db.setting.findUniqueOrThrow({ where: { key: WORKER_KEY } })).value, now)).toBe(false);
    expect(await workers[results.indexOf(true)].markReady(now)).toBe(true);
    expect(workerHeartbeatFresh((await db.setting.findUniqueOrThrow({ where: { key: WORKER_KEY } })).value, now)).toBe(true);
  });

  it('allows failover after an expired heartbeat without letting the old worker renew or erase the replacement', async () => {
    const now = Date.now();
    const old = new WorkerLease('old');
    const replacement = new WorkerLease('replacement');
    expect(await old.acquire(now)).toBe(true);
    expect(await replacement.acquire(now + 10000)).toBe(false);
    expect(await replacement.acquire(now + 31000)).toBe(true);
    expect(await old.renew(now + 32000)).toBe(false);
    await old.release();
    expect((await db.setting.findUniqueOrThrow({ where: { key: WORKER_KEY } })).value).toEqual({ owner: 'replacement', at: now + 31000, ready:false });
    expect(await replacement.renew(now + 33000)).toBe(true);
  });

  it('releases ownership immediately when the host stops a worker', async () => {
    const now = Date.now();
    const worker = new WorkerLease('worker');
    await worker.acquire(now);
    await worker.release();
    expect(workerHeartbeatFresh((await db.setting.findUniqueOrThrow({ where: { key: WORKER_KEY } })).value, now)).toBe(false);
    expect(await new WorkerLease('next-deployment').acquire(now + 1)).toBe(true);
  });

  it('respects a still-running worker from a previous version', async () => {
    const now = Date.now();
    await db.setting.create({ data: { key: WORKER_KEY, value: { at: now } } });
    expect(await new WorkerLease().acquire(now + 1000)).toBe(false);
  });
});
