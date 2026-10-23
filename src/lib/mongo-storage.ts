import './config';
import { MongoClient, type Db, type IndexDescription } from 'mongodb';
import { Prisma } from '@/generated/mongo';
import { mongoSettings } from './mongo-config';

let connection:Promise<MongoClient>|undefined;
export async function mongoDatabase(){
  const {url,database}=mongoSettings();
  connection??=new MongoClient(url,{serverSelectionTimeoutMS:15000}).connect().catch(error=>{connection=undefined;throw error;});
  return (await connection).db(database);
}
export async function closeMongoStorage(){if(connection){await (await connection).close();connection=undefined;}}

const extraIndexes:Record<string,IndexDescription[]>={
  User:[{key:{organizationId:1}}],
  Sheet:[{key:{organizationId:1,createdAt:1}}],
  Sender:[{key:{organizationId:1,provider:1,createdAt:1}}],
  Employee:[{key:{organizationId:1,active:1}}],
  GoogleCredential:[{key:{organizationId:1,createdAt:-1}}],
  SheetAccess:[{key:{sheetId:1}}],
  RuleRecipient:[{key:{employeeId:1}}],
  AuthSession:[{key:{userId:1}}],
  Lead:[{key:{sheetId:1,status:1,createdAt:1}},{key:{mobile:1}},{key:{nextFollowupAt:1}}],
  Assignment:[{key:{employeeId:1,active:1}},{key:{leadId:1},name:'one_active_primary_owner',unique:true,partialFilterExpression:{active:true,isPrimary:true}}],
  Message:[{key:{status:1,queuedAt:1}},{key:{leadId:1}}],
  Feedback:[{key:{leadId:1,submittedAt:1}}],
  Followup:[{key:{status:1,scheduledAt:1}},{key:{leadId:1}}],
  Job:[{key:{status:1,runAt:1}},{key:{organizationId:1,status:1,createdAt:1}}],
  SyncLog:[{key:{sheetId:1,createdAt:1}}],
  AuditLog:[{key:{entityType:1,entityId:1}}],
};

export async function initializeMongoDatabase(database:Db){
  if(!/^smartlead(?:_[a-z0-9_-]+)?$/.test(database.databaseName))throw new Error('Refusing to initialize a database outside the SmartLead namespace.');
  const hello=await database.command({hello:1});
  if(!hello.setName&&hello.msg!=='isdbgrid')throw new Error('SmartLead needs a MongoDB replica set for transactions. Use an existing replica set or MongoDB Atlas.');
  const settings=database.collection<{_id:string;value:{project:string;version:number}}>('settings');
  const identity=await settings.findOne({_id:'storage:project'});
  if(identity&&identity.value.project!=='smartlead')throw new Error('This database belongs to another project. No data was changed.');
  if(!identity){
    for(const collection of await database.listCollections({},{nameOnly:true}).toArray()){
      if(await database.collection(collection.name).findOne({}, {projection:{_id:1}}))throw new Error('The smartlead database already contains unrecognized data. No data was changed.');
    }
    await settings.insertOne({_id:'storage:project',value:{project:'smartlead',version:1}});
  }
  for(const model of Prisma.dmmf.datamodel.models){
    const indexes:IndexDescription[]=[];
    for(const field of model.fields.filter(field=>field.isUnique&&!field.isId)){
      const name=field.dbName||field.name;
      indexes.push({key:{[name]:1},name:model.name==='User'&&field.name==='email'?'email_present_unique':`${field.name}_unique`,unique:true,...(!field.isRequired?{partialFilterExpression:{[name]:{$type:'string'}}}:{})});
    }
    for(const unique of model.uniqueIndexes)indexes.push({key:Object.fromEntries(unique.fields.map(field=>[field,1])),name:unique.name||`${unique.fields.join('_')}_unique`,unique:true});
    indexes.push(...(extraIndexes[model.name]||[]));
    const collection=database.collection(model.dbName||model.name);
    if(indexes.length){
      await collection.createIndexes(indexes);
      // Install the partial index before removing the old email constraint.
      // Phone-only accounts have no email, and must coexist with legacy owners.
      if(model.name==='User')for(const index of await collection.listIndexes().toArray()){
        if(index.unique&&!index.partialFilterExpression&&Object.keys(index.key).length===1&&index.key.email===1&&index.name)await collection.dropIndex(index.name);
      }
    }
    else if(!(await database.listCollections({name:collection.collectionName},{nameOnly:true}).hasNext()))await database.createCollection(collection.collectionName);
  }
}
