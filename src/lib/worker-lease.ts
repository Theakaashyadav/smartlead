import { randomUUID } from 'node:crypto';
import { db } from './db';
import { workerLeaseFresh } from './worker-status';

export const WORKER_KEY = 'simple:worker';

// Atomic comparisons prevent two overlapping deployments from owning browsers.
export class WorkerLease {
  private value: { owner: string; at: number; ready: boolean } | null = null;
  constructor(private readonly owner: string = randomUUID()) {}

  async acquire(now = Date.now()) {
    const previous = await db.setting.findUnique({ where: { key: WORKER_KEY } });
    if (previous && workerLeaseFresh(previous.value, now)) return false;
    const value = { owner: this.owner, at: now, ready: false };
    if (!previous) {
      try { await db.setting.create({ data: { key: WORKER_KEY, value } }); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return false;
        throw error;
      }
    } else {
      if(previous.value === null)throw new Error('Worker heartbeat is invalid');
      const updated = await db.setting.updateMany({
        where: { key: WORKER_KEY, value: { equals: previous.value } },
        data: { value },
      });
      if (!updated.count) return false;
    }
    this.value = value;
    return true;
  }

  async renew(now = Date.now(), ready = this.value?.ready ?? false) {
    if (!this.value) return false;
    const value = { owner: this.owner, at: now, ready };
    const updated = await db.setting.updateMany({
      where: { key: WORKER_KEY, value: { equals: this.value } }, data: { value },
    });
    if (!updated.count) return false;
    this.value = value;
    return true;
  }

  async markReady(now = Date.now()) { return this.renew(now, true); }

  async release() {
    if (!this.value) return;
    await db.setting.updateMany({
      where: { key: WORKER_KEY, value: { equals: this.value } }, data: { value: { at: 0 } },
    });
    this.value = null;
  }
}
