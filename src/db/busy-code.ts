// SQLite's busy result codes, apart from busy.ts so the store port can name a held lock without importing SQL code.
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
// SQLITE_BUSY with extended code 2: a write on a read snapshot another writer has since moved past.
const SQLITE_BUSY_SNAPSHOT = 517;

function carriesErrcode(cause: unknown): cause is { errcode: unknown } {
  return typeof cause === 'object' && cause !== null && 'errcode' in cause;
}

export function isSqliteBusy(cause: unknown): boolean {
  const code = carriesErrcode(cause) ? cause.errcode : undefined;
  return code === SQLITE_BUSY || code === SQLITE_LOCKED || code === SQLITE_BUSY_SNAPSHOT;
}
