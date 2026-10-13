import type { AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import { db } from './db';
import { AppError, decrypt, encrypt, hash } from './security';

export async function socketAuthState(senderId: string) {
  const { BufferJSON, initAuthCreds, proto } = await import('baileys');
  const prefix = `whatsapp-socket-auth:${senderId}:`;
  const keyName = (type: string, id: string) => `${prefix}${type}:${hash(id)}`;
  let writes = Promise.resolve();
  const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
  const decode = (value: unknown): any => {
    try {
      if (!value || typeof value !== 'object' || !('encrypted' in value) || typeof value.encrypted !== 'string') throw new Error();
      return JSON.parse(decrypt(value.encrypted), BufferJSON.reviver);
    } catch {
      throw new AppError(503, 'The saved WhatsApp connection could not be decrypted. Restore the original encryption key or disconnect and link again.');
    }
  };
  const write = (task: () => Promise<void>) => {
    // Keep failures sticky: continuing after losing a Signal key can corrupt a session.
    writes = writes.then(task);
    return writes;
  };
  const save = async (key: string, json: string) => {
    const value = { encrypted: encrypt(json) };
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  };
  const stored = await db.setting.findUnique({ where: { key: `${prefix}creds` } });
  const state: AuthenticationState = {
    creds: stored ? decode(stored.value) : initAuthCreds(),
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        await writes;
        const rows = await db.setting.findMany({ where: { key: { in: ids.map(id => keyName(type, id)) } } });
        const indexed = new Map(rows.map(row => [row.key, row.value]));
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const value = indexed.get(keyName(type, id));
          if (value === undefined) continue;
          const decoded = decode(value);
          result[id] = type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(decoded) : decoded;
        }
        return result;
      },
      set(data: SignalDataSet) {
        // Snapshot buffers before entering the write queue; the caller can reuse them.
        const entries = Object.entries(data).flatMap(([type, keys]) => Object.entries(keys || {}).map(([id, value]) => ({
          key: keyName(type, id), json: value == null ? null : serialize(value),
        })));
        return write(async () => {
          for (const { key, json } of entries) {
            if (json === null) await db.setting.deleteMany({ where: { key } });
            else await save(key, json);
          }
        });
      },
    },
  };
  return {
    state,
    saveCreds() {
      const json = serialize(state.creds);
      return write(() => save(`${prefix}creds`, json));
    },
    flush: () => writes,
  };
}

export async function clearSocketAuth(senderId: string) {
  await db.setting.deleteMany({ where: { key: { startsWith: `whatsapp-socket-auth:${senderId}:` } } });
}
