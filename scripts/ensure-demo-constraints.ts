import '../src/lib/config';
import { db } from '../src/lib/db';
import { isDemo } from '../src/lib/config';
if(!isDemo())throw new Error('Demo constraints require DEMO_MODE=true');
db.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "Assignment_one_active_primary_owner" ON "Assignment" ("leadId") WHERE "active" = true AND "isPrimary" = true').then(()=>db.$disconnect());
