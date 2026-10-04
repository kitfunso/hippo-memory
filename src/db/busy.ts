import type { DatabaseSyncLike } from './sqlite.js';

export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return code === 5 || code === 6 || code === 517;
}

export const STORE_BUSY_MESSAGE = 'store busy (another hippo process holds the write lock); retry shortly';

// busy_timeout covers neither of this file's two contended statements: SQLite
// skips the busy handler for `PRAGMA journal_mode` and for a write that upgrades
// a deferred read snapshot. Both need an explicit wait instead.
export function execWithBusyRetry(db: DatabaseSyncLike, sql: string, timeoutMs = 30000): void {
  const deadline = Date.now() + timeoutMs;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      db.exec(sql);
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(idle, 0, 0, 10 + Math.floor(Math.random() * 20));
    }
  }
}
