import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// Managed hosts may cache node_modules without rerunning Puppeteer's installer.
// Prepare the browser during the Linux build, never during a user's request.
const skip = process.env.PUPPETEER_SKIP_DOWNLOAD;
const skipDownload = skip !== undefined && !['', '0', 'false', 'off'].includes(skip.toLowerCase());
const needsBrowser = !!process.env.WHATSAPP_LOGIN_MODE && process.env.WHATSAPP_LOGIN_MODE !== 'socket';
const installed = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].some(file => file && existsSync(file));
if (process.platform === 'linux' && needsBrowser && !skipDownload && !installed) {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('puppeteer/package.json')), 'lib', 'puppeteer', 'node', 'cli.js');
  console.log('Preparing the hosted Chromium browser for SmartLead.');
  const result = spawnSync(process.execPath, [cli, 'browsers', 'install', 'chrome'], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('Browser preparation failed. Enable Puppeteer downloads or provide an installed Chromium with CHROME_PATH.');
    process.exitCode = 1;
  }
}
