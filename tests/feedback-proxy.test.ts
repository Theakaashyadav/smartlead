import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFeedbackProxy, feedbackPathAllowed } from '@/lib/feedback-proxy';

const servers:Server[]=[];
async function listen(server:Server){servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
describe('employee feedback relay',()=>{
  it('forwards only feedback pages and their static assets, without admin credentials',async()=>{
    let received:any;
    const upstream=await listen(createServer((request,response)=>{received={path:request.url,cookie:request.headers.cookie,authorization:request.headers.authorization,origin:request.headers.origin};response.setHeader('Set-Cookie','admin=private');response.end('feedback page');}));
    const relay=await listen(createFeedbackProxy(upstream,()=> 'https://public.example',()=>({running:true})));
    const token='a'.repeat(43)+'.'+'b'.repeat(43);
    const page=await fetch(`${relay}/feedback/${token}`,{headers:{cookie:'admin=private',authorization:'Bearer private','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate'}});
    expect(await page.text()).toBe('feedback page');expect(page.headers.get('set-cookie')).toBeNull();
    expect(received).toEqual({path:`/feedback/${token}`,cookie:undefined,authorization:undefined,origin:upstream});
    for(const path of ['/login','/dashboard','/api/simple/state','/api/auth/login','/__smartlead_feedback_health'])expect((await fetch(relay+path)).status).toBe(404);
    expect(feedbackPathAllowed('/_next/static/chunks/app.js','GET')).toBe(true);
    expect(feedbackPathAllowed('/_next/static/%2e%2e/server.js','GET')).toBe(false);
  });
  it('rejects foreign-origin submissions and oversized feedback',async()=>{
    let requests=0;const upstream=await listen(createServer((_request,response)=>{requests++;response.end('ok');}));
    const relay=await listen(createFeedbackProxy(upstream,()=> 'https://public.example',()=>({running:true})));
    const path=`${relay}/api/feedback/${'a'.repeat(43)}.${'b'.repeat(43)}`;
    expect((await fetch(path,{method:'POST',headers:{origin:'https://foreign.example'},body:'{}'})).status).toBe(403);
    expect((await fetch(path,{method:'POST',body:'{}'})).status).toBe(403);
    expect((await fetch(path,{method:'POST',headers:{origin:'https://public.example'},body:'x'.repeat(100001)})).status).toBe(413);
    expect(requests).toBe(0);
    expect((await fetch(path,{method:'POST',headers:{origin:'https://public.example'},body:'{}'})).status).toBe(200);expect(requests).toBe(1);
  });
});
