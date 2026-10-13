export const SIMPLE_POLL_SECONDS = 5;
export const SEND_INTERVAL_MS = 250;
export const WORKER_IDLE_MS = 500;

// Existing public-sheet connections get the faster interval without a migration.
// Authenticated Sheets API connections keep their configured quota-aware interval.
export function sheetPollSeconds(sheet: { connectionType: string; syncInterval: number }) {
  return sheet.connectionType === 'SIMPLE_PUBLIC' ? SIMPLE_POLL_SECONDS : Math.max(5, sheet.syncInterval);
}
