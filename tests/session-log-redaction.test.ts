import { expect, it, vi } from 'vitest';
import { redactSessionLogs } from '@/lib/session-log-redaction';

it('removes WhatsApp session-key dumps while preserving unrelated diagnostics',()=>{
  const info=vi.fn();const warn=vi.fn();const target={info,warn};
  redactSessionLogs(target);redactSessionLogs(target);
  const sensitive={rootKey:Buffer.from('private session material')};
  target.info('Closing session:',sensitive);target.warn('Session already closed',sensitive);
  expect(info).toHaveBeenCalledWith('Closing session:','[session data omitted]');
  expect(warn).toHaveBeenCalledWith('Session already closed','[session data omitted]');
  target.warn('Sheet update failed',{stage:'browser-launch'});
  expect(warn).toHaveBeenLastCalledWith('Sheet update failed',{stage:'browser-launch'});
});
