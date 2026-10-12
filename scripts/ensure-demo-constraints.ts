import '../src/lib/config';
import { PrismaClient } from '../src/generated/demo';
import { isDemo } from '../src/lib/config';
if(!isDemo()||process.env.DATABASE_PROVIDER!=='sqlite')throw new Error('Demo constraints require DATABASE_PROVIDER=sqlite and DEMO_MODE=true');
const db=new PrismaClient();
db.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "Assignment_one_active_primary_owner" ON "Assignment" ("leadId") WHERE "active" = true AND "isPrimary" = true').then(()=>db.$disconnect());
