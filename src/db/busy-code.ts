// SQLite's busy result codes, apart from busy.ts so the store port can name a held lock without importing SQL code.
function carriesErrcode(cause: unknown): cause is { errcode: unknown } {
  return typeof cause === 'object' && cause !== null && 'errcode' in cause;
}

export function isSqliteBusy(cause: unknown): boolean {
  const code = carriesErrcode(cause) ? cause.errcode : undefined;
  return code === 5 || code === 6 || code === 517;
}
