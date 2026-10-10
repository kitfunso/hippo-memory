import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, log } from '../util/log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';
import { assertBinaryCompatible } from './migrate.js';
import { connectWithFacts, DEFAULT_BUSY_WAIT_MS, getHippoDbPath, type OpenedDb } from './connect.js';
import { currentRequestStores, isScopedHandle, runWithRequestStores } from './request-stores.js';
import { OtherStoreFolderError, SqliteBlockedError } from '../util/sqlite-blocked.js';

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

const sqliteBlockedBy = new AsyncLocalStorage<string>();

/** Runs `fn` so that every hippo.db open inside it, across awaits, throws; otherwise a missed port would create and write a hippo.db nobody reads. */
export function withSqliteBlocked<T>(storeKind: string, fn: () => T): T {
  return sqliteBlockedBy.run(storeKind, fn);
}

/** Runs `fn` with hippo.db opens allowed again, for a store whose own methods are backed by hippo.db, or a copy that reads the old hippo.db. */
export function withSqliteAllowed<T>(fn: () => T): T {
  return sqliteBlockedBy.exit(() => markerWaived.run(true, fn));
}

// Not a store kind: the block of a route whose SQLite work belongs on a worker thread, under the hippo.db store itself.
const OFF_LOOP = 'sqlite (off the event loop)';
const OFF_LOOP_MESSAGE = 'hippo.db was opened on the server thread by a route whose SQLite work runs on a worker thread';

/** Runs `fn` so that a hippo.db open on this thread throws, across awaits; a block of another store, when one is open, already refuses and stays as it is. */
export function withSqliteOffLoop<T>(fn: () => T): T {
  return sqliteBlockedBy.getStore() === undefined ? sqliteBlockedBy.run(OFF_LOOP, fn) : fn();
}

/** Leaves withSqliteOffLoop's block and nothing else: another store's block and the folder marker still refuse, which withSqliteAllowed would waive. */
export function outsideSqliteOffLoop<T>(fn: () => T): T {
  return sqliteBlockedBy.getStore() === OFF_LOOP ? sqliteBlockedBy.exit(fn) : fn();
}

/** First line of a best-effort catch around a hippo.db open: an unported path must fail closed, not fall back silently. */
export function rethrowIfSqliteBlocked<E>(err: E): void {
  if (err instanceof SqliteBlockedError) throw err;
}

/** store init --db, store copy --db and serve --db write this file in the hippo root; its text is the store kind. */
export const OTHER_STORE_MARKER = 'other-store';
const markerWaived = new AsyncLocalStorage<true>();

// An empty or unreadable marker still refuses: falling through would write the hippo.db the marker forbids.
function markerKind(marker: string): string {
  try {
    return readFileSync(marker, 'utf8').trim() || 'unknown';
  } catch (err) {
    log.debug(`${marker} is unreadable, so its store kind reads as unknown: ${errorMessage(err)}`);
    return 'unknown';
  }
}

/** Throws where hippo.db must not open; checked on every open, not cached, since the marker can appear while a process runs. */
export function assertSqliteAllowed(hippoRoot: string): void {
  const storeKind = sqliteBlockedBy.getStore();
  if (storeKind === OFF_LOOP) throw new SqliteBlockedError('sqlite', OFF_LOOP_MESSAGE);
  if (storeKind !== undefined) throw new SqliteBlockedError(storeKind);
  if (markerWaived.getStore()) return;
  const marker = join(hippoRoot, OTHER_STORE_MARKER);
  if (existsSync(marker)) throw new OtherStoreFolderError(markerKind(marker), marker);
}

/** `busyWaitMs` shortens every lock wait of this open, for a hook that must finish inside its own timeout. */
export function openHippoDb(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  return openHippoDbWithFacts(hippoRoot, opts).db;
}

/** openHippoDb, with what the open's probe read when this call made the connection. */
export function openHippoDbWithFacts(hippoRoot: string, opts?: { busyWaitMs?: number }): OpenedDb {
  assertSqliteAllowed(hippoRoot);
  const stores = currentRequestStores();
  return stores ? stores.getWithFacts(hippoRoot, opts) : connectWithFacts(hippoRoot, opts?.busyWaitMs);
}

/** Open an existing store without changing it: no mkdir, WAL switch, migration or mirror cleanup. Throws when hippo.db is missing. */
export function openHippoDbReadOnly(hippoRoot: string): DatabaseSyncLike {
  assertSqliteAllowed(hippoRoot);
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

/** Runs `fn` on an existing hippo.db opened without migrations, for a repair of a store whose schema is behind; closes it after. */
export function withUnmigratedDb<T>(hippoRoot: string, readOnly: boolean, fn: (db: DatabaseSyncLike) => T): T {
  // Skips openHippoDb, so it takes the same refusal itself.
  assertSqliteAllowed(hippoRoot);
  const file = getHippoDbPath(hippoRoot);
  if (!existsSync(file)) throw new Error(`No existing Hippo database at ${file}`);
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_WAIT_MS}`);
    return fn(db);
  } finally {
    db.close();
  }
}

export function closeHippoDb(db: DatabaseSyncLike): void {
  if (isScopedHandle(db)) return;
  db.close();
}
