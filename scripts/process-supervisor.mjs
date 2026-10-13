import { spawn } from 'node:child_process';

/** Supervise one web server and one worker; the hosting service supervises us. */
export function superviseProduction({ web, worker, env, spawnProcess = spawn, log = console.log, restartDelay = 1000, shutdownTimeout = 40000 }) {
  const children = new Map();
  let stopping = false;
  let retry;
  let deadline;
  let result = 0;
  let attempts = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const report = (event, fields = {}) => log(JSON.stringify({ event, ...fields }));

  function complete() {
    if (stopping && children.size === 0) {
      clearTimeout(deadline);
      finish(result);
    }
  }

  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    result = code;
    clearTimeout(retry);
    report('smartlead_stopping');
    for (const child of children.values()) child.kill('SIGTERM');
    deadline = setTimeout(() => {
      for (const child of children.values()) child.kill('SIGKILL');
      finish(result || 1);
    }, shutdownTimeout);
    complete();
  }

  function launch(role, args) {
    if (stopping) return;
    const started = Date.now();
    let child;
    let settled = false;
    const exited = (code, signal) => {
      if (settled) return;
      settled = true;
      children.delete(role);
      if (stopping) { complete(); return; }
      report('smartlead_process_exit', { role, code, signal });
      if (role === 'web') { stop(code || 1); return; }
      if (Date.now() - started > 60000) attempts = 0;
      const delay = Math.min(restartDelay * 2 ** Math.min(attempts++, 5), 30000);
      report('smartlead_worker_restarting', { delayMs: delay });
      retry = setTimeout(() => launch('worker', worker), delay);
    };
    try {
      child = spawnProcess(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
      children.set(role, child);
      child.once('error', error => {
        report('smartlead_process_error', { role, code: error.code || 'UNKNOWN' });
        exited(1, null);
      });
      child.once('exit', exited);
      report('smartlead_process_started', { role, pid: child.pid });
    } catch (error) {
      report('smartlead_process_error', { role, code: error.code || 'UNKNOWN' });
      exited(1, null);
    }
  }

  launch('web', web);
  if (worker) launch('worker', worker);
  return { stop, done };
}
