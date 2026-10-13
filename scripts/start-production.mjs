import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import nextEnv from '@next/env';
import { superviseProduction } from './process-supervisor.mjs';

export async function startProduction(args = process.argv.slice(2)) {
  process.env.NODE_ENV = 'production';
  nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  await import('./check-config.mjs');
  if (process.exitCode) return;
  const dataDirectory = path.resolve(process.env.SMARTLEAD_DATA_DIR || 'data');
  const env = {
    ...process.env,
    SMARTLEAD_EXTERNAL_WORKER: 'true',
    HOSTNAME: '0.0.0.0',
    WHATSAPP_LOGIN_MODE: process.env.WHATSAPP_LOGIN_MODE || 'socket',
    WHATSAPP_PROFILE_DIR: process.env.WHATSAPP_PROFILE_DIR || path.join(dataDirectory, 'whatsapp-web'),
    WHATSAPP_SESSION_DIR: process.env.WHATSAPP_SESSION_DIR || path.join(dataDirectory, 'sessions'),
    WHATSAPP_REMOTE_AUTH_DIR: process.env.WHATSAPP_REMOTE_AUTH_DIR || path.join(dataDirectory, 'auth-archives'),
  };
  try {
    for (const directory of [env.WHATSAPP_PROFILE_DIR, env.WHATSAPP_SESSION_DIR, env.WHATSAPP_REMOTE_AUTH_DIR]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const require = createRequire(import.meta.url);
    const webOnly=args.includes('--web-only');
    const webArgs=args.filter(arg=>arg!=='--web-only');
    const standalone=path.resolve('.next','standalone','server.js');
    const supervisor = superviseProduction({
      web: existsSync(standalone)&&!webArgs.length?[standalone]:[require.resolve('next/dist/bin/next'), 'start', '--hostname', '0.0.0.0', ...webArgs],
      worker: webOnly?null:['--import', 'tsx', path.resolve('src/worker.ts')],
      env,
    });
    const stop = () => supervisor.stop();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    supervisor.done.then(code => {
      process.exitCode = code;
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    });
    return supervisor;
  } catch {
    console.error(JSON.stringify({ event: 'smartlead_start_failed', message: 'Cannot prepare server storage. Check the hosted runtime directory permissions.' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const supervisor = await startProduction();
  if (supervisor) await supervisor.done;
}
