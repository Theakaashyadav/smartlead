import { inject,afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { initializeMongoDatabase } from '@/lib/mongo-storage';

declare module 'vitest' {export interface ProvidedContext {mongoURI:string}}
process.env.DEMO_MODE='true';
process.env.LEAD_STORAGE_MODE='permanent';
process.env.DATABASE_PROVIDER='mongodb';
process.env.MONGODB_URI=inject('mongoURI');
process.env.MONGODB_DATABASE=`smartlead_test_${process.pid}`;
process.env.SESSION_SECRET='test-session-secret-32-characters-minimum';
process.env.ENCRYPTION_KEY='ab'.repeat(32);
process.env.GOOGLE_SERVICE_ACCOUNT_BASE64=Buffer.from('{}').toString('base64');
process.env.APP_URL='http://localhost:3000';
process.env.PUBLIC_FEEDBACK_URL='';
const client=new MongoClient(process.env.MONGODB_URI);
await client.connect();
const database=client.db(process.env.MONGODB_DATABASE);
await initializeMongoDatabase(database);
await database.collection('organizations').updateOne({_id:'legacy'} as never,{$setOnInsert:{name:'Test organisation',createdAt:new Date()}},{upsert:true});
afterAll(()=>client.close());
