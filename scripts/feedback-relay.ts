import '../src/lib/config';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/lib/db';
import { appUrl } from '../src/lib/config';
import { createFeedbackProxy } from '../src/lib/feedback-proxy';

let url:string|null=null;let connected=false;let stopping=false;
const server=createFeedbackProxy(appUrl(),()=>url,()=>({running:true,url,connected}));
async function publish(){if(url&&connected)await db.setting.upsert({where:{key:'feedback:public'},create:{key:'feedback:public',value:{url,at:Date.now()}},update:{value:{url,at:Date.now()}}});}
async function run(){
  await mkdir('data',{recursive:true});
  await db.setting.upsert({where:{key:'feedback:remoteRequired'},create:{key:'feedback:remoteRequired',value:true},update:{value:true}});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(3001,'127.0.0.1',resolve);});
  await writeFile('data/smartlead-feedback.pid',String(process.pid));
  const executable=process.env.CLOUDFLARED_PATH||path.resolve('tools/cloudflared.exe');
  const tunnel=spawn(executable,['tunnel','--no-autoupdate','--url','http://127.0.0.1:3001','--protocol','http2','--metrics','127.0.0.1:0'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  if(tunnel.pid)await writeFile('data/feedback-tunnel.pid',String(tunnel.pid));
  let output='';
  const receive=(chunk:Buffer)=>{
    const text=chunk.toString();output=(output+text).slice(-16000);
    const found=output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if(found)url=found[0];
    if(/Unregistered tunnel connection|Connection terminated|failed to serve tunnel connection|Retrying connection/i.test(text))connected=false;
    if(/Registered tunnel connection/.test(text))connected=true;
    void publish().catch(()=>{});
    void appendFile('data/feedback-relay.log',text.replace(/\/(?:f|(?:api\/)?feedback)\/[\w.-]+/g,'/feedback/[redacted]')).catch(()=>{});
  };
  tunnel.stdout.on('data',receive);tunnel.stderr.on('data',receive);
  tunnel.on('error',()=>{connected=false;console.error('Could not start the feedback tunnel.');});
  tunnel.on('exit',()=>{connected=false;if(!stopping){console.error('Feedback tunnel stopped. Run Start SmartLead.cmd again.');process.exitCode=1;server.close();clearInterval(timer);void db.$disconnect();}});
  const timer=setInterval(()=>void publish().catch(()=>{}),10000);timer.unref();
  const stop=()=>{stopping=true;connected=false;clearInterval(timer);tunnel.kill();server.close();void db.$disconnect();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
run().catch(()=>{console.error('Public feedback links could not start. Check data/feedback-relay.log.');process.exitCode=1;server.close();void db.$disconnect();});
