import '../src/lib/config';
import { db } from '../src/lib/db';
import { synchronizeSheet, writebackLead, enqueue, transaction } from '../src/lib/engine';
import { closePublicSheetEditor } from '../src/lib/public-sheet-editor';
import { stat } from 'node:fs/promises';
import { appUrl } from '../src/lib/config';

async function run(){
  if(process.argv.includes('--retry-writebacks')){
    const started=(await stat('data/smartlead-worker.pid')).mtime;
    await transaction(async tx=>{
      const where={key:{startsWith:'writeback:feedback-upgrade:'},OR:[{status:'PENDING',error:{in:['Background operation failed; check integration configuration.','Google Sheets editor is temporarily unavailable. The sheet update will retry.']}},{status:'PROCESSING',lockedAt:{lt:started}}]};
      const jobs=await tx.job.findMany({where,select:{entityId:true}});
      const result=await tx.job.updateMany({where,data:{status:'PENDING',attempts:0,lockedAt:null,lockToken:null,error:null,runAt:new Date()}});
      await tx.lead.updateMany({where:{id:{in:jobs.map(j=>j.entityId)},writebackStatus:'ERROR'},data:{writebackStatus:'PENDING'}});
      console.log(JSON.stringify({sheetUpdatesRetried:result.count}));
    });return;
  }
  if(process.argv.includes('--allow-local')){
    if(process.argv.includes('--clickable')){
      const app=new URL(appUrl());
      if(app.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(app.hostname))throw new Error('Clickable local feedback requires a local HTTP APP_URL. A hosted domain is used directly.');
      const origin=`http://smartlead.example.com${app.port?`:${app.port}`:''}`;
      await db.setting.upsert({where:{key:'feedback:localOrigin'},create:{key:'feedback:localOrigin',value:origin},update:{value:origin}});
    }
    await db.setting.upsert({where:{key:'feedback:remoteRequired'},create:{key:'feedback:remoteRequired',value:false},update:{value:false}});
    console.log('Local feedback enabled. External links will use the public APP_URL after hosting.');return;
  }
  if(process.argv.includes('--retry-one')){
    const lead=await db.lead.findFirstOrThrow({where:{sheet:{connectionType:'SIMPLE_PUBLIC'},writebackStatus:'ERROR'},orderBy:{sourceRow:'asc'}});
    await writebackLead(lead.id);console.log('A previously failed public-sheet row was verified.');return;
  }
  if(process.argv.includes('--mark-pending')){
    await transaction(async tx=>{
      const jobs=await tx.job.findMany({where:{type:'WRITEBACK',status:'PENDING',key:{startsWith:'writeback:feedback-upgrade:'}},select:{entityId:true}});
      const result=await tx.lead.updateMany({where:{id:{in:jobs.map(j=>j.entityId)},writebackStatus:'SYNCED'},data:{writebackStatus:'PENDING'}});
      console.log(JSON.stringify({backfillQueued:result.count}));
    });return;
  }
  if(process.argv.includes('--require-remote'))await db.setting.upsert({where:{key:'feedback:remoteRequired'},create:{key:'feedback:remoteRequired',value:true},update:{value:true}});
  const sheets=await db.sheet.findMany({where:{connectionType:'SIMPLE_PUBLIC'}});
  for(const sheet of sheets){
    const result=await synchronizeSheet(sheet.id);
    const assigned=await db.lead.findMany({where:{sheetId:sheet.id,sourceDeleted:false,assignments:{some:{active:true,isPrimary:true}}},orderBy:{sourceRow:'asc'}});
    if(assigned[0])await writebackLead(assigned[0].id);
    for(const lead of assigned.slice(1)){
      await transaction(async tx=>{
        const job=await enqueue(tx,'WRITEBACK',lead.id,`writeback:feedback-upgrade:${lead.id}:${lead.version}`);
        if(job.status==='PENDING')await tx.lead.updateMany({where:{id:lead.id,version:lead.version,writebackStatus:'SYNCED'},data:{writebackStatus:'PENDING'}});
      });
    }
    console.log(JSON.stringify({sheetId:sheet.id,imported:result.imported,questionsCaptured:assigned.filter(l=>(l.sourceData as {questions?:unknown[]}|null)?.questions?.length).length,existingAssignments:assigned.length,firstRowVerified:!!assigned[0]}));
  }
}
run().catch(error=>{console.error(error instanceof Error?`${error.constructor.name}: ${error.message.replace(/https?:\/\/\S+/g,'[URL]')}`:'Feedback upgrade failed');process.exitCode=1;}).finally(async()=>{await closePublicSheetEditor();await db.$disconnect();});
