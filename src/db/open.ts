import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cleanupArchivedMirrors } from '../raw-archive-mirror-cleanup.js';
import { log } from '../log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { execWithBusyRetry } from './busy.js';
import { tableExists } from './tables.js';
import { assertBinaryCompatible, runMigrations } from './migrate.js';

export function getHippoDbPath(hippoRoot: string): string {
  return path.join(hippoRoot, 'hippo.db');
}

// Hook commands run on every prompt, so inside withSharedStoreHandles each store pays its pragmas, migration check and mirror cleanup once.
const sharedHandles = new Map<string, DatabaseSyncLike>();
const sharedSet = new WeakSet<DatabaseSyncLike>();
let shareDepth = 0;
let shareBusyWaitMs: number | undefined;

/** Lock wait for hook commands: under the 5 s prompt-hook budget even after a few skipped writes, and far above a normal write's hold. */
export const HOOK_DB_WAIT_MS = 1000;

/** A busy store made a command skip work: warn once per process (the holder is usually `hippo sleep`). */
export function noteStoreBusy(skipped: string): void {
  log.once('store-busy', 'warn', `store busy (another hippo process holds the write lock); ${skipped}`);
  // A lock held past one full wait belongs to a long transaction, so the hook's later writes skip at once.
  for (const db of sharedHandles.values()) {
    if (db.isOpen !== false) db.exec('PRAGMA busy_timeout = 0');
  }
}

function closeSharedStoreHandles(): void {
  for (const db of sharedHandles.values()) {
    sharedSet.delete(db);
    if (db.isOpen !== false) db.close();
  }
  sharedHandles.clear();
}

/** Runs `fn` with one handle per store: openHippoDb reuses it and closeHippoDb leaves it open until `fn` settles or the process exits.
 *  `busyWaitMs` is the lock wait of every open inside `fn` that does not pass its own. */
export async function withSharedStoreHandles<T>(fn: () => T | Promise<T>, opts?: { busyWaitMs?: number }): Promise<T> {
  if (shareDepth++ === 0) {
    process.once('exit', closeSharedStoreHandles);
    shareBusyWaitMs = opts?.busyWaitMs;
  }
  try {
    return await fn();
  } finally {
    if (--shareDepth === 0) {
      process.off('exit', closeSharedStoreHandles);
      closeSharedStoreHandles();
      shareBusyWaitMs = undefined;
    }
  }
}

/** Lock wait inside an HTTP request: SQLite waits synchronously, so a long wait would stall every other request on the event loop. */
export const SERVER_DB_WAIT_MS = 250;

/** Lock wait for each of sleep's short write transactions, even inside a server request: a run stops only on a writer that holds the lock longer. */
export const SLEEP_DB_WAIT_MS = 5000;

const scopedBusyWaitMs = new AsyncLocalStorage<number>();

/** Runs `fn` so that every store opened inside it, across awaits, waits at most `busyWaitMs` for a lock unless the open passes its own. */
export function withBusyWait<T>(busyWaitMs: number, fn: () => T): T {
  return scopedBusyWaitMs.run(busyWaitMs, fn);
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
  if (shareDepth === 0) return openOwnHippoDb(hippoRoot, { busyWaitMs: opts?.busyWaitMs ?? scopedBusyWaitMs.getStore() });
  const busyWaitMs = opts?.busyWaitMs ?? shareBusyWaitMs ?? scopedBusyWaitMs.getStore();
  const key = `${path.resolve(getHippoDbPath(hippoRoot))}\0${busyWaitMs ?? ''}`;
  const shared = sharedHandles.get(key);
  if (shared?.isOpen && !shared.isTransaction) return shared;
  const db = openOwnHippoDb(hippoRoot, { busyWaitMs });
  // An open nested inside a transaction gets its own connection, as it did before sharing.
  if (!shared?.isOpen) {
    sharedHandles.set(key, db);
    sharedSet.add(db);
  }
  return db;
}

// Owner-only on create; SQLite gives the WAL and SHM files the db's mode. Existing paths keep theirs.
function createStoreFilesOwnerOnly(hippoRoot: string): void {
  fs.mkdirSync(hippoRoot, { recursive: true, mode: 0o700 });
  try {
    fs.closeSync(fs.openSync(getHippoDbPath(hippoRoot), 'wx', 0o600));
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
  }
}

function openOwnHippoDb(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  createStoreFilesOwnerOnly(hippoRoot);
  const db = new DatabaseSync(getHippoDbPath(hippoRoot));
  const busyWaitMs = opts?.busyWaitMs;
  try {
    db.exec(`PRAGMA busy_timeout = ${busyWaitMs ?? 5000}`);
    execWithBusyRetry(db, 'PRAGMA journal_mode = WAL', busyWaitMs);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA wal_autocheckpoint = 100');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, hippoRoot, busyWaitMs);
    // Path A backfill: delete any orphan markdown mirrors for already-archived
    // raw_archive rows. Idempotent via per-row raw_archive.mirror_cleaned_at
    // (v21). Wrapped in try/catch — a filesystem failure must not prevent DB open.
    try {
      cleanupArchivedMirrors(hippoRoot, db);
    } catch (cleanupErr) {
      log.error(`openHippoDb: cleanupArchivedMirrors failed (non-fatal): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
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
  if (sharedSet.has(db)) return;
  db.close();
}
