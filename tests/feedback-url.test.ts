import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/mongo';
import { feedbackBaseURL } from '@/lib/feedback-url';
import { simpleLeadMessage } from '@/lib/simple-shared';

function settings(values:Record<string,unknown>={}){
  return {setting:{findUnique:vi.fn(async({where}:{where:{key:string}})=>where.key in values?{key:where.key,value:values[where.key]}:null)}} as unknown as Pick<Prisma.TransactionClient,'setting'>;
}
afterEach(()=>vi.unstubAllEnvs());
describe('feedback links that recipients can open',()=>{
  it('holds sends with localhost URLs by default and permits an explicit local development override',async()=>{
    vi.stubEnv('PUBLIC_FEEDBACK_URL','');vi.stubEnv('APP_URL','http://127.0.0.1:3000');
    await expect(feedbackBaseURL(settings(),true)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});
    expect(await feedbackBaseURL(settings({'feedback:remoteRequired':false}),true)).toBe('http://127.0.0.1:3000');
    expect(await feedbackBaseURL(settings(),false)).toBe('http://127.0.0.1:3000');
  });
  it('uses the local test address even if a previous relay has expired',async()=>{
    vi.stubEnv('PUBLIC_FEEDBACK_URL','');vi.stubEnv('APP_URL','http://127.0.0.1:3000');
    const previousRelay={url:'https://old-relay.example',at:Date.now()-60000};
    expect(await feedbackBaseURL(settings({'feedback:remoteRequired':false,'feedback:public':previousRelay}),true)).toBe('http://127.0.0.1:3000');
  });
  it('uses the mapped local hostname only for explicitly enabled local tests',async()=>{
    vi.stubEnv('PUBLIC_FEEDBACK_URL','');vi.stubEnv('APP_URL','http://127.0.0.1:3000');
    const local={'feedback:remoteRequired':false,'feedback:localOrigin':'http://smartlead.example.com:3000'};
    expect(await feedbackBaseURL(settings(local),true)).toBe('http://smartlead.example.com:3000');
    await expect(feedbackBaseURL(settings({...local,'feedback:remoteRequired':true}),true)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});
    for(const address of ['http://attacker.example:3000','http://smartlead.example.com:4000','javascript:alert(1)','http://user:pass@smartlead.example.com:3000']){
      await expect(feedbackBaseURL(settings({...local,'feedback:localOrigin':address}),true)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});
    }
    vi.stubEnv('APP_URL','https://my-hostinger.example');
    expect(await feedbackBaseURL(settings(local),true)).toBe('https://my-hostinger.example');
  });
  it('uses the hosted domain ahead of any previous relay or local test setting',async()=>{
    vi.stubEnv('PUBLIC_FEEDBACK_URL','');vi.stubEnv('APP_URL','https://smartlead.example/');
    for(const at of [Date.now(),Date.now()-60000]){
      expect(await feedbackBaseURL(settings({'feedback:remoteRequired':false,'feedback:public':{url:'https://old-relay.example',at}}),true)).toBe('https://smartlead.example');
    }
  });
  it('uses a public HTTPS configured URL and rejects local, private, and invalid addresses',async()=>{
    vi.stubEnv('PUBLIC_FEEDBACK_URL','https://feedback.example/');
    expect(await feedbackBaseURL(settings(),true)).toBe('https://feedback.example');
    for(const value of ['not a URL','javascript:alert(1)','http://feedback.example','https://localhost','https://127.0.0.1','https://192.168.1.2','https://user:pass@feedback.example']){
      vi.stubEnv('PUBLIC_FEEDBACK_URL',value);
      await expect(feedbackBaseURL(settings(),true)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});
    }
  });
  it('uses a live relay address, pauses when stale, and supports a hosted application',async()=>{
    vi.stubEnv('PUBLIC_FEEDBACK_URL','');vi.stubEnv('APP_URL','http://127.0.0.1:3000');
    const relay={url:'https://relay.example',at:Date.now()};
    expect(await feedbackBaseURL(settings({'feedback:public':relay}),true)).toBe(relay.url);
    await expect(feedbackBaseURL(settings({'feedback:public':{...relay,at:Date.now()-60000}}),true)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});
    await expect(feedbackBaseURL(settings({'feedback:public':{url:relay.url}}),true)).rejects.toMatchObject({code:'FEEDBACK_OFFLINE'});
    vi.stubEnv('APP_URL','https://smartlead.example');
    expect(await feedbackBaseURL(settings(),true)).toBe('https://smartlead.example');
  });
  it('places the complete URL on its own line below Submit Feedback, keeping token punctuation intact',()=>{
    const url=`https://feedback.example/feedback/${'a'.repeat(43)}.${'b'.repeat(43)}`;
    const body=simpleLeadMessage({customerName:'Sample lead',mobile:'+919876543210'},'Enquiries',url);
    expect(body).toContain(`*Submit Feedback*\n${url}\nThank you!`);
    expect(body).not.toContain('[Submit Feedback](');
    expect(body.match(/https?:\/\/\S+/)?.[0]).toBe(url);
  });
});
