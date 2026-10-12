import './config';
import { PrismaClient, type Prisma } from '@/generated/mongo';
import { PrismaClient as DemoClient } from '@/generated/demo';
import { mongoSettings } from './mongo-config';
export const usingSQLite=process.env.DATABASE_PROVIDER==='sqlite';
const globalDb = globalThis as unknown as { smartleadDb?: PrismaClient };
export const db = globalDb.smartleadDb ?? (usingSQLite ? new DemoClient() as unknown as PrismaClient : new PrismaClient(process.env.MONGODB_URI?{datasources:{db:{url:mongoSettings().url}}}:undefined));
if (process.env.NODE_ENV !== 'production') globalDb.smartleadDb = db;
export type Transaction = Prisma.TransactionClient;
export function databaseTransaction<T>(fn:(tx:Transaction)=>Promise<T>):Promise<T>{
  if(usingSQLite)return (db as unknown as DemoClient).$transaction(tx=>fn(tx as unknown as Transaction),{isolationLevel:'Serializable',maxWait:10000,timeout:20000});
  return db.$transaction(fn,{maxWait:10000,timeout:20000});
}
export async function databaseHealth(){
  if(usingSQLite){await (db as unknown as DemoClient).$queryRaw`SELECT 1`;return;}
  mongoSettings();
  await db.$runCommandRaw({ping:1});
}
