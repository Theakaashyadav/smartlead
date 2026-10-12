import { beforeEach, describe, expect, it, vi } from 'vitest';
const files=vi.hoisted(()=>({exists:vi.fn()}));
vi.mock('node:fs',()=>({existsSync:files.exists}));
import { browserExecutablePath } from '@/lib/browser-executable';

beforeEach(()=>{vi.unstubAllEnvs();vi.stubEnv('CHROME_PATH','');files.exists.mockReset();});
describe('worker browser discovery',()=>{
  it('finds an asynchronously resolved Puppeteer browser outside the system installation paths',async()=>{
    const cached='/private/puppeteer/chrome';files.exists.mockImplementation(file=>file===cached);
    expect(await browserExecutablePath(async()=>cached)).toBe(cached);
  });
  it('uses the explicitly configured browser without resolving the download cache',async()=>{
    vi.stubEnv('CHROME_PATH','/custom/chrome');files.exists.mockReturnValue(true);
    const cached=vi.fn();expect(await browserExecutablePath(cached)).toBe('/custom/chrome');expect(cached).not.toHaveBeenCalled();
  });
  it('reports an unavailable explicit browser instead of silently changing it',async()=>{
    vi.stubEnv('CHROME_PATH','/missing/chrome');files.exists.mockReturnValue(false);
    const cached=vi.fn();expect(await browserExecutablePath(cached)).toBeNull();expect(cached).not.toHaveBeenCalled();
  });
  it('handles an absent Puppeteer download',async()=>{
    files.exists.mockReturnValue(false);
    expect(await browserExecutablePath(async()=>{throw new Error('Browser not downloaded');})).toBeNull();
  });
});
