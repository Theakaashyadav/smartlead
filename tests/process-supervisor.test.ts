import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { superviseProduction } from '../scripts/process-supervisor.mjs';

function fixture() {
  const children: Array<EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> }> = [];
  const spawnProcess = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { pid: children.length + 100, kill: vi.fn() });
    children.push(child);
    return child;
  });
  const env = { PORT: '4310', APP_URL: 'https://smartlead.example.com' };
  const supervisor = superviseProduction({ web: ['web'], worker: ['worker'], env, spawnProcess: spawnProcess as unknown as typeof spawn, log: vi.fn(), restartDelay: 100, shutdownTimeout: 1000 });
  return { supervisor, children, spawnProcess, env };
}

afterEach(() => vi.useRealTimers());
describe('hosted web and worker supervision', () => {
  it('starts both processes with the same hosting environment and restarts a failed worker', async () => {
    vi.useFakeTimers();
    const { supervisor, children, spawnProcess, env } = fixture();
    expect(spawnProcess).toHaveBeenNthCalledWith(1, process.execPath, ['web'], expect.objectContaining({ env }));
    expect(spawnProcess).toHaveBeenNthCalledWith(2, process.execPath, ['worker'], expect.objectContaining({ env }));
    children[1].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(children).toHaveLength(3);
    expect(children[0].kill).not.toHaveBeenCalled();
    supervisor.stop();
    children[0].emit('exit', 0, null);
    children[2].emit('exit', 0, null);
    expect(await supervisor.done).toBe(0);
  });

  it('stops the worker when the web server exits so the host can restart the entire app', async () => {
    vi.useFakeTimers();
    const { supervisor, children } = fixture();
    children[0].emit('exit', 1, null);
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
    children[1].emit('exit', 0, null);
    expect(await supervisor.done).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(2);
  });

  it('cancels a pending worker restart during a deployment shutdown', async () => {
    vi.useFakeTimers();
    const { supervisor, children } = fixture();
    children[1].emit('exit', 1, null);
    supervisor.stop();
    children[0].emit('exit', 0, null);
    expect(await supervisor.done).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(2);
  });

  it('terminates a hung child after the shutdown deadline', async () => {
    vi.useFakeTimers();
    const { supervisor, children } = fixture();
    supervisor.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(children.every(child => child.kill.mock.calls.some(([signal]) => signal === 'SIGKILL'))).toBe(true);
    expect(await supervisor.done).toBe(1);
  });
});
