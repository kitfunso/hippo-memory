import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '../log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';
import { assertBinaryCompatible } from './migrate.js';
import { connectHippoDb, getHippoDbPath } from './connect.js';
import { currentRequestStores, isScopedHandle, runWithRequestStores } from './request-stores.js';

export { getHippoDbPath };

/** Lock wait for hook commands: under the 5 s prompt-hook budget even after a few skipped writes, and far above a normal write's hold. */
export const HOOK_DB_WAIT_MS = 1000;

/** Lock wait inside an HTTP request: SQLite waits synchronously, so a long wait would stall every other request on the event loop. */
export const SERVER_DB_WAIT_MS = 250;

/** A busy store made a command skip work: warn once per process (the holder is usually `hippo sleep`). */
export function noteStoreBusy(skipped: string): void {
  log.once('store-busy', 'warn', `store busy (another hippo process holds the write lock); ${skipped}`);
  currentRequestStores()?.noteBusy();
}

/** Runs `fn` with one handle per store: openHippoDb reuses it and closeHippoDb leaves it open until `fn` settles or the process exits.
 *  `busyWaitMs` is the lock wait of every open inside `fn` that does not pass its own. */
export async function withSharedStoreHandles<T>(fn: () => T | Promise<T>, opts?: { busyWaitMs?: number }): Promise<T> {
  return runWithRequestStores(fn, { busyWaitMs: opts?.busyWaitMs });
}

/** Lock wait for each of sleep's short write transactions, even inside a server request: a run stops only on a writer that holds the lock longer. */
export const SLEEP_DB_WAIT_MS = 5000;

/** The lock wait an open here would get without its own `busyWaitMs`: the request scope's; undefined outside every scope. */
export function scopedBusyWait(): number | undefined {
  return currentRequestStores()?.busyWaitMs;
}

/** Thrown by a hippo.db open inside a request served from another store: the code path is not ported to the store port yet. */
export class SqliteBlockedError extends Error {
  constructor(readonly storeKind: string) {
    super(`hippo.db is not opened while the '${storeKind}' store serves this request; this code path is not ported to the store yet`);
    this.name = 'SqliteBlockedError';
  }
}

const sqliteBlockedBy = new AsyncLocalStorage<string>();

/** Runs `fn` so that every hippo.db open inside it, across awaits, throws; otherwise a missed port would create and write a hippo.db nobody reads. */
export function withSqliteBlocked<T>(storeKind: string, fn: () => T): T {
  return sqliteBlockedBy.run(storeKind, fn);
}

function assertSqliteAllowed(): void {
  const storeKind = sqliteBlockedBy.getStore();
  if (storeKind !== undefined) throw new SqliteBlockedError(storeKind);
}

/** `busyWaitMs` shortens every lock wait of this open, for a hook that must finish inside its own timeout. */
export function openHippoDb(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  assertSqliteAllowed();
  const stores = currentRequestStores();
  return stores ? stores.get(hippoRoot, opts) : connectHippoDb(hippoRoot, opts?.busyWaitMs);
}

/** Open an existing store without changing it: no mkdir, WAL switch, migration or mirror cleanup. Throws when hippo.db is missing. */
export function openHippoDbReadOnly(hippoRoot: string): DatabaseSyncLike {
  assertSqliteAllowed();
  const db = new DatabaseSync(getHippoDbPath(hippoRoot), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (tableExists(db, 'meta')) assertBinaryCompatible(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Best effort only.
    }
    throw error;
  }
}

export function closeHippoDb(db: DatabaseSyncLike): void {
  if (isScopedHandle(db)) return;
  db.close();
}
