import { beforeEach, describe, expect, it, vi } from 'vitest';
const browser = vi.hoisted(() => ({ path: vi.fn(), launch: vi.fn(), close: vi.fn() }));
vi.mock('@/lib/browser-executable', () => ({ browserExecutablePath: browser.path }));
vi.mock('puppeteer', () => ({ executablePath: vi.fn(), launch: browser.launch }));
import { verifyWorkerBrowser } from '@/lib/worker-browser';

beforeEach(() => {
  browser.path.mockReset().mockResolvedValue('/host/chromium');
  browser.close.mockReset().mockResolvedValue(undefined);
  browser.launch.mockReset().mockResolvedValue({ close: browser.close });
});
describe('hosted browser readiness', () => {
  it('checks that a headless browser can start and closes the probe before reporting ready', async () => {
    await verifyWorkerBrowser();
    expect(browser.launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/host/chromium', headless: true }));
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it('fails explicitly when the hosting deployment has no browser', async () => {
    browser.path.mockResolvedValue(null);
    await expect(verifyWorkerBrowser()).rejects.toMatchObject({ reason: 'BROWSER_MISSING' });
    expect(browser.launch).not.toHaveBeenCalled();
  });
  it('identifies hosting process limits without leaking private browser output', async () => {
    browser.launch.mockRejectedValue(new Error('private-token: pthread_create: Resource temporarily unavailable'));
    await expect(verifyWorkerBrowser()).rejects.toMatchObject({ reason: 'BROWSER_HOST_CAPACITY', message: expect.not.stringContaining('private-token') });
  });
  it('identifies missing Linux browser libraries', async () => {
    browser.launch.mockRejectedValue(new Error('error while loading shared libraries: libnss3.so: cannot open shared object file'));
    await expect(verifyWorkerBrowser()).rejects.toMatchObject({ reason: 'BROWSER_SYSTEM_LIBRARIES' });
  });
});
