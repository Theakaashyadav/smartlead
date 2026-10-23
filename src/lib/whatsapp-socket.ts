import type { Contact, WASocket, WAMessage } from 'baileys';
import type { Sender } from '@/generated/mongo';
import QRCode from 'qrcode';
import pino from 'pino';
import { db, databaseTransaction } from './db';
import { queueDeliveryWriteback } from './delivery';
import { AppError, decrypt } from './security';
import { phoneSchema } from './validation';
import type { WhatsAppContact } from './simple-shared';
import { clearSocketAuth, socketAuthState } from './whatsapp-socket-auth';
import { UncertainDelivery, type SendInput, type WhatsAppProvider } from './whatsapp';

type Session = {
  id: string; stopped: boolean; connected: boolean; attempts: number;
  auth?: Awaited<ReturnType<typeof socketAuthState>>; socket?: WASocket;
  opening?: Promise<void>; retry?: ReturnType<typeof setTimeout>;
  events: Promise<void>; background: Promise<void>; warming?: Promise<void>;
  contacts: Map<string, WhatsAppContact>; recipients: Map<string, { jid: string; expiresAt: number }>;
};
const sessions = new Map<string, Session>();
const logger = pino({ level: 'silent' });
const providerId = (senderId: string, id: string) => `socket:${senderId}:${id}`;
const phoneFromJid = (jid?: string | null) => {
  if (!jid || !/^(?:\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.test(jid)) return null;
  const result = phoneSchema.safeParse(`+${jid.split('@')[0].split(':')[0]}`);
  return result.success ? result.data : null;
};
const update = (id: string, data: Record<string, unknown>) => db.sender.update({ where: { id }, data });

async function fail(session: Session) {
  session.stopped = true; session.connected = false; clearTimeout(session.retry);
  session.socket?.end(new Error('WhatsApp connection stopped'));
  if (sessions.get(session.id) !== session) return;
  sessions.delete(session.id);
  console.error(JSON.stringify({ event: 'whatsapp_socket_failed', reason: 'CONNECTION_OR_STORAGE' }));
  await update(session.id, { status: 'ERROR', qrCode: null, lastError: 'The WhatsApp connection stopped. Check the server database connection, then try again.' }).catch(() => {});
}

async function saveContacts(session: Session, contacts: Partial<Contact>[]) {
  for (const contact of contacts) {
    let jid = contact.phoneNumber || contact.id;
    if (jid?.endsWith('@lid')) jid = await session.socket?.signalRepository.lidMapping.getPNForLID(jid) || undefined;
    const phone = phoneFromJid(jid);
    if (!phone || phone === phoneFromJid(session.socket?.user?.id)) continue;
    const previous = session.contacts.get(phone);
    session.contacts.set(phone, { phone, name: contact.name || contact.notify || contact.verifiedName || previous?.name || phone });
  }
  const key = `whatsapp-contacts:${session.id}`;
  const value = { contacts: [...session.contacts.values()].sort((a, b) => a.name.localeCompare(b.name)), updatedAt: new Date().toISOString(), error: null };
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function reconcile(session: Session, messages: WAMessage[]) {
  // Match only IDs reserved by this app before submission, never arbitrary chat history.
  const own = messages.filter(item => item.key.fromMe && item.key.id);
  const pending = [];
  for (let offset = 0; offset < own.length; offset += 500) pending.push(...await db.message.findMany({ where: {
    senderId: session.id, status: 'FAILED', uncertain: true,
    providerMessageId: { in: own.slice(offset, offset + 500).map(item => providerId(session.id, item.key.id!)) },
  } }));
  const indexed = new Map(pending.map(message => [message.providerMessageId, message]));
  for (const item of own) {
    const message = indexed.get(providerId(session.id, item.key.id!));
    if (!message) continue;
    const body = item.message?.conversation || item.message?.extendedTextMessage?.text;
    if (phoneFromJid(item.key.remoteJid) !== message.recipient || body !== decrypt(message.encryptedBody)) continue;
    await databaseTransaction(async tx=>{
      const updated=await tx.message.updateMany({ where: { id: message.id, status: 'FAILED', uncertain: true }, data: {
        status: 'SUBMITTED', uncertain: false, submittedAt: new Date(), failedAt: null, failureReason: null,
      } });
      if(updated.count)await queueDeliveryWriteback(tx,message,`reconciled:${message.attemptCount}`);
    });
  }
}

async function wakePendingSends(session: Session) {
  const queued = await db.message.findMany({ where: { senderId: session.id, status: 'QUEUED', lead: { sheet: { rule: { enabled: true } } } }, select: { id: true } });
  for (let offset = 0; offset < queued.length; offset += 500) await db.job.updateMany({
    where: { type: 'SEND', status: 'PENDING', entityId: { in: queued.slice(offset, offset + 500).map(message => message.id) } },
    data: { runAt: new Date() },
  });
}

async function warmRecipients(session: Session, socket: WASocket) {
  const selected = await db.ruleRecipient.findMany({ where: { rule: { senderId: session.id, enabled: true }, employee: { active: true } }, select: { employee: { select: { phone: true } } } });
  const numbers = [...new Set(selected.map(recipient => recipient.employee.phone.replace('+', '')))];
  for (let offset = 0; offset < numbers.length && !session.stopped; offset += 50) {
    const registered = await socket.onWhatsApp(...numbers.slice(offset, offset + 50));
    if (session.socket !== socket || !session.connected) return;
    for (const recipient of registered || []) {
      const phone = phoneFromJid(recipient.jid);
      if (recipient.exists && phone) session.recipients.set(phone, { jid: recipient.jid, expiresAt: Date.now() + 3600000 });
    }
  }
}

async function open(session: Session) {
  const { default: makeWASocket, DisconnectReason } = await import('baileys');
  if (session.stopped) return;
  session.auth ||= await socketAuthState(session.id);
  await session.auth.saveCreds();
  if (session.stopped) return;
  const socket = makeWASocket({
    auth: session.auth.state, logger, markOnlineOnConnect: false, syncFullHistory: false,
    connectTimeoutMs: 20000, defaultQueryTimeoutMs: 25000, keepAliveIntervalMs: 15000,
    getMessage: async key => {
      if (!key.id) return;
      const message = await db.message.findUnique({ where: { providerMessageId: providerId(session.id, key.id) } });
      if (message?.senderId === session.id) return { conversation: decrypt(message.encryptedBody) };
    },
  });
  session.socket = socket;
  const handle = (task: () => Promise<void>, background = false) => {
    const lane = background ? 'background' : 'events';
    session[lane] = session[lane].then(async () => {
      if (!session.stopped && session.socket === socket) await task();
    }).catch(() => {
      if (!background) return fail(session);
      console.error(JSON.stringify({ event: 'whatsapp_background_sync_failed' }));
    });
  };
  socket.ev.on('creds.update', creds => handle(async () => {
    Object.assign(session.auth!.state.creds, creds); await session.auth!.saveCreds();
  }));
  socket.ev.on('contacts.upsert', contacts => handle(() => saveContacts(session, contacts), true));
  socket.ev.on('contacts.update', contacts => handle(() => saveContacts(session, contacts), true));
  socket.ev.on('messaging-history.set', event => handle(async () => {
    await saveContacts(session, event.contacts); await reconcile(session, event.messages);
  }, true));
  socket.ev.on('messages.upsert', event => handle(() => reconcile(session, event.messages), true));
  socket.ev.on('connection.update', event => {
    if (session.socket === socket && event.connection === 'close') session.connected = false;
    handle(async () => {
    if (event.qr) {
      const qrCode = await QRCode.toDataURL(event.qr, { width: 264, margin: 2 });
      await update(session.id, { status: 'WAITING_QR', qrCode, lastError: null });
    }
    if (event.connection === 'open') {
      await session.auth!.saveCreds(); session.connected = true; session.attempts = 0;
      await update(session.id, { status: 'CONNECTED', qrCode: null, phone: phoneFromJid(socket.user?.id), lastConnectedAt: new Date(), lastError: null });
      await wakePendingSends(session);
      handle(() => saveContacts(session, []), true);
      session.warming = warmRecipients(session, socket).catch(() => {});
    } else if (event.connection === 'close') {
      session.connected = false;
      const error = event.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
      const code = error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const terminal = loggedOut || code === DisconnectReason.forbidden || code === DisconnectReason.connectionReplaced ||
        (!session.auth!.state.creds.registered && code === DisconnectReason.timedOut);
      if (terminal) {
        session.stopped = true; sessions.delete(session.id);
        if (loggedOut) { await session.auth!.flush().catch(() => {}); await clearSocketAuth(session.id); }
        await update(session.id, { status: loggedOut ? 'AUTH_REQUIRED' : 'DISCONNECTED', qrCode: null, lastError: 'WhatsApp disconnected. Connect again to resume sending.' });
        return;
      }
      await update(session.id, { status: 'CONNECTING', qrCode: null, lastError: null });
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(1000 * 2 ** Math.min(session.attempts++, 5), 30000);
      session.retry = setTimeout(() => {
        if (!session.stopped) void open(session).catch(() => fail(session));
      }, delay);
      session.retry.unref();
    }
    });
  });
}

async function stop(session: Session) {
  session.stopped = true; session.connected = false; clearTimeout(session.retry);
  await session.opening?.catch(() => {});
  session.socket?.end(new Error('Worker stopped'));
  await session.events; await Promise.all([session.background, session.warming]); await session.auth?.flush().catch(() => {});
  if (sessions.get(session.id) === session) sessions.delete(session.id);
}

export async function closeSocketWhatsApp() {
  await Promise.all([...sessions.values()].map(stop));
}

export class SocketWhatsAppProvider implements WhatsAppProvider {
  constructor(private sender: Sender) {}
  async connect() {
    const existing = sessions.get(this.sender.id);
    if (existing && !existing.stopped) { await existing.opening; return; }
    const session: Session = { id: this.sender.id, stopped: false, connected: false, attempts: 0, events: Promise.resolve(), background: Promise.resolve(), contacts: new Map(), recipients: new Map() };
    sessions.set(this.sender.id, session);
    session.opening = (async () => {
      await update(session.id, { status: 'CONNECTING', qrCode: null, lastError: null });
      const cached = await db.setting.findUnique({ where: { key: `whatsapp-contacts:${session.id}` } });
      const contacts = (cached?.value as { contacts?: WhatsAppContact[] } | undefined)?.contacts || [];
      for (const contact of contacts) session.contacts.set(contact.phone, contact);
      await open(session);
    })();
    try { await session.opening; } catch (error) { await fail(session); throw error; }
  }
  async disconnect() {
    const session = sessions.get(this.sender.id);
    if (session) {
      session.stopped = true; clearTimeout(session.retry);
      await session.opening?.catch(() => {});
      await session.socket?.logout().catch(() => {}); await stop(session);
    }
    await clearSocketAuth(this.sender.id);
    await update(this.sender.id, { status: 'DISCONNECTED', qrCode: null, lastError: null });
  }
  async getConnectionStatus() { return sessions.get(this.sender.id)?.connected ? 'CONNECTED' : 'DISCONNECTED'; }
  async getQRCode() { return (await db.sender.findUniqueOrThrow({ where: { id: this.sender.id } })).qrCode; }
  async refreshContacts() {
    const session = sessions.get(this.sender.id);
    if (!session?.connected) throw new AppError(409, 'WhatsApp is disconnected', 'DISCONNECTED');
    await session.background;
    if (!session.connected) throw new AppError(409, 'WhatsApp is reconnecting; leads remain queued.', 'DISCONNECTED');
    await saveContacts(session, []);
    return [...session.contacts.values()];
  }
  async sendMessage(input: SendInput) {
    const session = sessions.get(this.sender.id);
    if (!session?.connected || !session.socket) throw new AppError(409, 'WhatsApp is disconnected', 'DISCONNECTED');
    const socket = session.socket;
    let recipient = session.recipients.get(input.to);
    if (!recipient || recipient.expiresAt <= Date.now()) {
      let checked;
      try { checked = (await socket.onWhatsApp(input.to.replace('+', '')))?.find(item => item.exists); }
      catch { throw new AppError(409, 'WhatsApp is reconnecting; outgoing leads remain queued.', 'DISCONNECTED'); }
      if (!checked) throw new AppError(400, 'This phone number is not registered on WhatsApp.');
      recipient = { jid: checked.jid, expiresAt: Date.now() + 3600000 };
      session.recipients.set(input.to, recipient);
    }
    if (!session.connected) throw new AppError(409, 'WhatsApp is reconnecting; leads remain queued.', 'DISCONNECTED');
    const { generateMessageIDV2 } = await import('baileys');
    const messageId = generateMessageIDV2(socket.user?.id);
    if (input.messageId) {
      const claimed = await db.message.updateMany({ where: { id: input.messageId, senderId: this.sender.id, status: 'PROCESSING' }, data: { providerMessageId: providerId(this.sender.id, messageId) } });
      if (!claimed.count) throw new AppError(409, 'This notification is no longer pending submission.');
    }
    try {
      const message = await socket.sendMessage(recipient.jid, { text: input.body, linkPreview: null }, { messageId });
      if (message?.key.id !== messageId) throw new Error('Missing submission identifier');
      return { id: providerId(this.sender.id, messageId), status: 'SUBMITTED' as const };
    } catch {
      throw new UncertainDelivery('WhatsApp submission outcome is uncertain. Check the linked account before resending.');
    }
  }
  async getMessageStatus() { return null; }
  async handleIncomingEvents() {}
}
