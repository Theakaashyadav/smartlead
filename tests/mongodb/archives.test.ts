import { afterAll,expect,it,vi } from 'vitest';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { EncryptedAuthStore } from '@/lib/whatsapp-archives';
import { closeMongoStorage,mongoDatabase } from '@/lib/mongo-storage';
import { db } from '@/lib/db';

afterAll(async()=>{await closeMongoStorage();await db.$disconnect();});
it('keeps encrypted WhatsApp backups isolated by account and replaces them safely',async()=>{
  const directory=await mkdtemp(path.resolve('data','archive-test-'));
  vi.stubEnv('WHATSAPP_SESSION_DIR',directory);
  const store=new EncryptedAuthStore();const first='RemoteAuth-test-one',second='RemoteAuth-test-two';
  try{
    await writeFile(path.join(directory,`${first}.zip`),'private-first-session');
    await writeFile(path.join(directory,`${second}.zip`),'private-second-session');
    expect(await store.sessionExists({session:first})).toBe(false);
    await store.save({session:first});await store.save({session:second});
    const database=await mongoDatabase();
    const chunk=await database.collection('whatsapp_archives.chunks').findOne();
    expect(chunk?.data.toString()).not.toContain('private-first-session');
    await writeFile(path.join(directory,`${first}.zip`),'updated-first-session');await store.save({session:first});
    expect(await database.collection('whatsapp_archives.files').countDocuments({filename:`${first}.enc`})).toBe(1);
    const restored=path.join(directory,'restored.zip');await store.extract({session:first,path:restored});
    expect(await readFile(restored,'utf8')).toBe('updated-first-session');
    await store.delete({session:first});expect(await store.sessionExists({session:first})).toBe(false);
    expect(await store.sessionExists({session:second})).toBe(true);
    await store.extract({session:second,path:restored});expect(await readFile(restored,'utf8')).toBe('private-second-session');
    await expect(store.save({session:'../invalid'})).rejects.toThrow('Invalid session');
  }finally{vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});}
});
