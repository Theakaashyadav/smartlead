import { browserExecutablePath } from './browser-executable';

export class WorkerBrowserError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);this.name='WorkerBrowserError';Object.setPrototypeOf(this,new.target.prototype);
  }
}

export async function verifyWorkerBrowser() {
  try {
    const puppeteer = await import('puppeteer');
    const executablePath = await browserExecutablePath(() => puppeteer.executablePath());
    if (!executablePath) throw new WorkerBrowserError('BROWSER_MISSING', 'Install Chromium on the hosting server or enable Puppeteer browser downloads, then restart SmartLead.');
    const browser = await puppeteer.launch({
      executablePath, headless: true, timeout: 20000,
      args: process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [],
    });
    await browser.close();
  } catch (error) {
    if(error instanceof WorkerBrowserError)throw error;
    const message = error instanceof Error ? error.message : '';
    if (/pthread_create|Resource temporarily unavailable|cannot fork/i.test(message)) {
      throw new WorkerBrowserError('BROWSER_HOST_CAPACITY', 'The hosting account cannot start Chromium with its current process or memory limits. Use the supplied Hostinger VPS deployment or increase the server limits.');
    }
    if (/shared librar|\.so.*not found/i.test(message)) {
      throw new WorkerBrowserError('BROWSER_SYSTEM_LIBRARIES', 'Chromium system libraries are missing on the hosting server. The supplied Docker deployment installs them.');
    }
    throw new WorkerBrowserError('BROWSER_START_FAILED', 'Chromium could not start on the hosting server. Check CHROME_PATH, browser permissions, and hosting process limits.');
  }
}
