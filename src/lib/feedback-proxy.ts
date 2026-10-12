import { createServer, request as upstreamRequest, type IncomingHttpHeaders } from 'node:http';

export function feedbackPathAllowed(path:string,method:string){
  if(/^\/(?:api\/)?feedback\/[\w.-]{30,100}$/.test(path))return path.startsWith('/api/')?['GET','HEAD','POST'].includes(method):['GET','HEAD'].includes(method);
  return ['GET','HEAD'].includes(method)&&/^\/_next\/static\/[\w./%-]+$/.test(path)&&!path.includes('..')&&!/%2e|%2f|%5c/i.test(path);
}
export function createFeedbackProxy(upstream:string,publicOrigin:()=>string|null,health:()=>unknown){
  const target=new URL(upstream);
  if(target.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(target.hostname))throw new Error('Feedback relay upstream must be the local SmartLead server.');
  return createServer((incoming,outgoing)=>{
    const method=incoming.method||'GET';const path=(incoming.url||'/').split('?')[0];
    if(path==='/__smartlead_feedback_health'&&incoming.headers.host==='127.0.0.1:3001'){
      outgoing.setHeader('Content-Type','application/json');outgoing.end(JSON.stringify(health()));return;
    }
    if(!feedbackPathAllowed(path,method)){outgoing.writeHead(404);outgoing.end('Not found');return;}
    const origin=incoming.headers.origin;
    if((origin&&origin!==publicOrigin())||(method==='POST'&&(!origin||incoming.headers['sec-fetch-site']==='cross-site'))){
      outgoing.writeHead(403);outgoing.end('Invalid request origin');return;
    }
    if(Number(incoming.headers['content-length']||0)>100000){outgoing.writeHead(413);outgoing.end('Request too large');return;}
    const headers:IncomingHttpHeaders={...incoming.headers,host:target.host,origin:target.origin,'sec-fetch-site':'same-origin'};
    delete headers.cookie;delete headers.authorization;delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];
    const proxy=upstreamRequest({hostname:target.hostname,port:target.port||80,path:incoming.url,method,headers,timeout:30000},response=>{
      const responseHeaders={...response.headers};delete responseHeaders['set-cookie'];
      outgoing.writeHead(response.statusCode||502,responseHeaders);response.pipe(outgoing);
    });
    let size=0;incoming.on('data',chunk=>{size+=chunk.length;if(size>100000){proxy.destroy();outgoing.writeHead(413);outgoing.end('Request too large');}});
    proxy.on('timeout',()=>proxy.destroy());proxy.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end('Feedback service unavailable. Try again shortly.');});
    incoming.pipe(proxy);
  });
}
