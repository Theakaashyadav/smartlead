import './config';
import { PrismaClient, type Prisma } from '@/generated/postgres';
import { PrismaClient as DemoClient } from '@/generated/demo';
import { isDemo } from './config';
const globalDb = globalThis as unknown as { smartleadDb?: PrismaClient };
export const db = globalDb.smartleadDb ?? (isDemo() ? new DemoClient() as unknown as PrismaClient : new PrismaClient());
if (process.env.NODE_ENV !== 'production') globalDb.smartleadDb = db;
export type Transaction = Prisma.TransactionClient;
