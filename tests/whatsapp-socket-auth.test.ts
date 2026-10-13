import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { clearSocketAuth, socketAuthState } from '@/lib/whatsapp-socket-auth';

beforeEach(()=>db.setting.deleteMany({where:{key:{startsWith:'whatsapp-socket-auth:'}}}));
afterAll(()=>db.$disconnect());

describe('encrypted browserless WhatsApp authentication',()=>{
  it('restores credentials and binary Signal keys from the database without plaintext secrets',async()=>{
    const auth=await socketAuthState('one');
    auth.state.creds.advSecretKey='private-auth-secret';
    await auth.saveCreds();
    await auth.state.keys.set({session:{alice:Buffer.from('private-signal-session')}});
    const stored=JSON.stringify(await db.setting.findMany());
    expect(stored).not.toContain('private-auth-secret');expect(stored).not.toContain('private-signal-session');
    const restored=await socketAuthState('one');
    expect(restored.state.creds.advSecretKey).toBe('private-auth-secret');
    expect(restored.state.creds.noiseKey.private).toEqual(auth.state.creds.noiseKey.private);
    expect((await restored.state.keys.get('session',['alice'])).alice).toEqual(Buffer.from('private-signal-session'));
  });
  it('isolates organisations and removes only the selected account on logout',async()=>{
    const one=await socketAuthState('one');const two=await socketAuthState('two');
    await one.state.keys.set({session:{same:Buffer.from('one')}});
    await two.state.keys.set({session:{same:Buffer.from('two')}});
    await one.state.keys.set({session:{same:null}});
    expect(await one.state.keys.get('session',['same'])).toEqual({});
    await clearSocketAuth('one');
    expect((await two.state.keys.get('session',['same'])).same).toEqual(Buffer.from('two'));
  });
  it('refuses to replace unreadable authentication with a new identity',async()=>{
    await db.setting.create({data:{key:'whatsapp-socket-auth:one:creds',value:{encrypted:'corrupted'}}});
    await expect(socketAuthState('one')).rejects.toThrow('could not be decrypted');
    expect((await db.setting.findUniqueOrThrow({where:{key:'whatsapp-socket-auth:one:creds'}})).value).toEqual({encrypted:'corrupted'});
  });
});
