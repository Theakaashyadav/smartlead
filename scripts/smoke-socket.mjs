// Exercise the built standalone app against WhatsApp without linking an account.
// All application records and authentication are isolated in a temporary SQLite DB.
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const runtime = await mkdtemp(path.resolve('data', 'socket-smoke-'));
const database = new DatabaseSync(path.join(runtime, 'test.db'));
database.exec(await readFile('prisma/demo-schema.sql', 'utf8')); database.close();
const standalone = path.resolve('.next', 'standalone');
await access(path.join(standalone, 'server.js'));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, NODE_ENV: 'production', SMARTLEAD_EXTERNAL_WORKER: '',
  DATABASE_PROVIDER: 'sqlite', DEMO_MODE: 'false',
  DEMO_DATABASE_URL: `file:${path.join(runtime, 'test.db').replaceAll('\\', '/')}`,
  APP_URL: origin, HOSTNAME: '127.0.0.1', PORT: String(port),
  SESSION_SECRET: 'isolated-browserless-smoke-secret-32-characters', ENCRYPTION_KEY: 'ab'.repeat(32),
  SMARTLEAD_DATA_DIR: runtime, WHATSAPP_LOGIN_MODE: 'socket', CHROME_PATH: '/must-not-launch-a-browser',
  WHATSAPP_PROFILE_DIR: '', WHATSAPP_SESSION_DIR: '', WHATSAPP_REMOTE_AUTH_DIR: '',
};
let child, closed, output = '', cookie = '';
function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: standalone, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  closed = new Promise(resolve => child.once('close', resolve));
}
async function stop() { child?.kill('SIGTERM'); await closed; }
async function api(route, body) {
  const response = await fetch(`${origin}/api/${route}`, {
    method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
  });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `API returned ${response.status}`);
  return result.data;
}
async function waitFor(check, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`${label} failed. Server output:\n${output.slice(-4000)}`);
}
try {
  start(); await waitFor(async () => (await api('health')).workerRunning, 'Embedded worker startup');
  await api('auth/register', { name: 'Isolated smoke', organizationName: 'Isolated smoke', email: 'smoke@example.test', password: 'IsolatedSmokePassword!2026' });
  await api('simple/whatsapp/connect', {});
  const qrReady = async () => {
    const state = await api('simple/state');
    return state.workerRunning && state.account?.status === 'WAITING_QR' && state.account.qrCode?.startsWith('data:image/png;base64,');
  };
  await waitFor(qrReady, 'Live WhatsApp QR through the built application');
  console.log('SOCKET SMOKE: standalone worker generated a real WhatsApp QR without Chromium.');
  await stop(); start();
  await waitFor(qrReady, 'Saved connection restore after server restart');
  console.log('SOCKET SMOKE PASSED: the built application restored database authentication and regenerated its QR after restarting. No account was linked and no messages were sent.');
} finally { await stop(); }
