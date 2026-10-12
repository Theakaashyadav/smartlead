import { afterEach,describe,expect,it,vi } from 'vitest';
import { checkOrigin } from '@/lib/security';

const domain='https://lightslategray-oryx-425713.hostingersite.com';
const request=(origin:string,headers:Record<string,string>={})=>new Request('http://127.0.0.1:3000/api/auth/register',{method:'POST',headers:{origin,'sec-fetch-site':'same-origin',...headers}});
afterEach(()=>vi.unstubAllEnvs());
describe('hosted request origin validation',()=>{
  it('accepts the configured HTTPS domain when the reverse proxy uses an internal HTTP URL',()=>{
    vi.stubEnv('APP_URL',`${domain}/`);
    expect(()=>checkOrigin(request(domain))).not.toThrow();
    expect(()=>checkOrigin(request('http://127.0.0.1:3000'))).toThrow('Invalid request origin');
  });
  it('explains a local APP_URL mismatch without accepting arbitrary proxy headers',()=>{
    vi.stubEnv('APP_URL','http://127.0.0.1:3000');
    expect(()=>checkOrigin(request(domain,{'x-forwarded-host':new URL(domain).host,'x-forwarded-proto':'https'}))).toThrow('Set APP_URL in the hosting environment');
  });
  it('rejects cross-site traffic, other domains, schemes, ports, and malformed origins',()=>{
    vi.stubEnv('APP_URL',domain);
    expect(()=>checkOrigin(request(domain,{'sec-fetch-site':'cross-site'}))).toThrow('Cross-site');
    for(const origin of ['https://attacker.invalid',domain.replace('https:','http:'),`${domain}:4000`,'null','not-a-url',`${domain}/path`,`${domain}/`,`https://user:password@${new URL(domain).host}`]){
      expect(()=>checkOrigin(request(origin))).toThrow('Invalid request origin');
    }
  });
});
