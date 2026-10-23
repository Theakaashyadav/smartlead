const installed=new WeakSet<object>();
const messages=new Set(['Closing session:','Opening session:','Removing old closed session:','Session already closed']);
// libsignal bypasses the configured Baileys logger for these messages and
// includes private ratchet keys. Retain the event text, never the session dump.
export function redactSessionLogs(target:Pick<Console,'info'|'warn'>=console){
  if(installed.has(target))return;
  for(const method of ['info','warn'] as const){
    const original=target[method];
    target[method]=(...args:unknown[])=>original.apply(target,typeof args[0]==='string'&&messages.has(args[0])?[args[0],'[session data omitted]']:args);
  }
  installed.add(target);
}
