import { db, usingSQLite } from './db';
import { transaction } from './engine';
import { SUCCESSFUL_SEND_STATUSES } from './delivery';

const recoveryKey='sheets:output-layout-v2';
export async function recoverSheetOutputs(){
  if(await db.setting.findUnique({where:{key:recoveryKey}}))return 0;
  const candidates=await db.lead.findMany({where:{
    sheet:{connectionType:{startsWith:'SIMPLE_'}},sourceDeleted:false,
    AND:[usingSQLite?{redactedAt:null}:{OR:[{redactedAt:null},{redactedAt:{isSet:false}}]},
      {OR:[{messages:{some:{status:{in:SUCCESSFUL_SEND_STATUSES},uncertain:false}}},{feedback:{some:{}}}]}],
  },select:{id:true,sheet:{select:{organizationId:true}}}});
  let queued=0;
  for(const lead of candidates){
    queued+=await transaction(async tx=>{
      const key=`writeback:outputs-v2:${lead.id}`;
      if(await tx.job.findUnique({where:{key}}))return 0;
      await tx.lead.update({where:{id:lead.id},data:{writebackStatus:'PENDING',version:{increment:1}}});
      await tx.job.create({data:{key,type:'WRITEBACK',entityId:lead.id,organizationId:lead.sheet.organizationId}});
      return 1;
    });
  }
  await db.setting.upsert({where:{key:recoveryKey},create:{key:recoveryKey,value:{queued,at:Date.now()}},update:{}});
  return queued;
}
