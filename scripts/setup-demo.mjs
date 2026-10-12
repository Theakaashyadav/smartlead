import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
mkdirSync('data', { recursive: true });
if (!existsSync('.env')) writeFileSync('.env', `DEMO_MODE=true\nDEMO_DATABASE_URL=file:../data/demo.db\nDATABASE_URL=postgresql://smartlead:local@localhost:5432/smartlead\nAPP_URL=http://localhost:3000\nSESSION_SECRET=${randomBytes(48).toString('base64url')}\nENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`);
if (!/DEMO_MODE=true/.test(readFileSync('.env','utf8'))) throw new Error('demo:setup requires DEMO_MODE=true. Use a separate demo directory/database.');
// Prisma's Windows schema engine cannot always create a missing SQLite file.
// Create the empty file first; Prisma still owns all table/index migrations.
const emptyDatabase = new DatabaseSync('data/demo.db');
emptyDatabase.close();
const upgrade=spawnSync(process.execPath,['scripts/upgrade-organizations.mjs'],{stdio:'inherit'});
if(upgrade.status)process.exit(upgrade.status);
for (const args of [['prisma','generate'], ['prisma','generate','--schema','prisma/demo.prisma'], ['prisma','db','push','--schema','prisma/demo.prisma'], ['tsx','scripts/ensure-demo-constraints.ts'], ['tsx','prisma/seed.ts']]) {
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio:'inherit', shell:process.platform === 'win32' });
  if (r.status) process.exit(r.status);
}
console.log('\nSmartLead demo ready. Run npm run dev. Login: admin@smartlead.demo / SmartLead!2026\n');
