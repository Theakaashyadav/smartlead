import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// SQLite's additive upgrade retains lead history and browser/session IDs.
if(existsSync('.env'))process.loadEnvFile('.env');
if(process.env.DATABASE_PROVIDER!=='sqlite'||process.env.DEMO_MODE!=='true')throw new Error('This upgrade is for legacy SQLite demos only. Use npm run db:setup for MongoDB.');
const url=process.env.DEMO_DATABASE_URL||'file:../data/demo.db';
if(!url.startsWith('file:'))throw new Error('Expected a SQLite file URL.');
const file=path.resolve('prisma',url.slice(5));
if(!existsSync(file)){console.log('No existing local database to upgrade.');process.exit(0);}
const sqlite=new DatabaseSync(file);
try{
  const tables=['User','Sheet','Sender','Employee','GoogleCredential','Job'];
  const columns=table=>sqlite.prepare(`PRAGMA table_info("${table}")`).all();
  if(!columns('User').length){console.log('Empty database; demo:setup will create the schema.');process.exit(0);}
  if(tables.every(table=>columns(table).some(column=>column.name==='organizationId'))){
    console.log('Organisation separation is already installed.');
  }else{
    const directory=path.join(path.dirname(file),'backups');mkdirSync(directory,{recursive:true});
    const backup=path.join(directory,`before-organizations-${Date.now()}.db`);
    sqlite.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
    sqlite.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try{
      sqlite.exec('CREATE TABLE IF NOT EXISTS "Organization" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      const workspace=sqlite.prepare('SELECT "value" FROM "Setting" WHERE "key" = ?').get('workspace');
      let name='My Organisation';try{name=JSON.parse(workspace?.value||'{}').name||name;}catch{}
      sqlite.prepare('INSERT OR IGNORE INTO "Organization" ("id","name") VALUES (?,?)').run('legacy',name);
      for(const table of tables)if(!columns(table).some(column=>column.name==='organizationId')){
        sqlite.exec(`ALTER TABLE "${table}" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'legacy' CONSTRAINT "${table}_organizationId_fkey" REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE`);
      }
      sqlite.exec('DROP INDEX IF EXISTS "Sheet_spreadsheetId_worksheetId_key"; DROP INDEX IF EXISTS "Employee_phone_key"');
      sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS "Sheet_organizationId_spreadsheetId_worksheetId_key" ON "Sheet" ("organizationId","spreadsheetId","worksheetId")');
      sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS "Employee_organizationId_phone_key" ON "Employee" ("organizationId","phone")');
      if(sqlite.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Foreign key check failed; no changes were applied.');
      sqlite.exec('COMMIT');
      console.log(`Organisation separation installed. Backup: ${backup}`);
    }catch(error){sqlite.exec('ROLLBACK');throw error;}finally{sqlite.exec('PRAGMA foreign_keys=ON');}
  }
}finally{sqlite.close();}
