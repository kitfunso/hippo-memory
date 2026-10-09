import type { DatabaseSyncLike } from './sqlite.js';

export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return code === 5 || code === 6 || code === 517;
}

export const STORE_BUSY_MESSAGE = 'store busy (another hippo process holds the write lock); retry shortly';

/** A store behind the port throws this when its lock wait runs out, so the server answers 503 as it does for a busy hippo.db. */
export class StoreBusyError extends Error {
  constructor(message: string = STORE_BUSY_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreBusyError';
  }
}

/** A held lock in any store: SQLite's busy codes or a port's StoreBusyError. */
export function isStoreBusy<E>(error: E): boolean {
  return error instanceof StoreBusyError || isSqliteBusy(error);
}

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

function undoScope(db: DatabaseSyncLike, top: boolean, name: string): void {
  if (top) {
    db.exec('ROLLBACK');
  } else {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
  }
}

/** Runs `fn` as one write: BEGIN IMMEDIATE on an idle handle, else SAVEPOINT `name` inside the caller's transaction.
 *  A deferred scope that reads first cannot wait out another writer, while BEGIN IMMEDIATE waits the open's busy_timeout. */
export function withWriteScope<T>(db: DatabaseSyncLike, name: string, fn: () => T): T {
  const top = db.isTransaction === false;
  db.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(top ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { undoScope(db, top, name); } catch { /* already rolled back; keep the original error */ }
    throw error;
  }
}

/** Runs the reads in `fn` against one snapshot, so two statements cannot straddle another process's write. */
export function withReadSnapshot<T>(db: DatabaseSyncLike, fn: () => T): T {
  if (db.isTransaction !== false) return fn();
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    db.exec('COMMIT');
  }
}

/** What `withWriteScopeOr` hands its callback's `rollback(value)`; a class so no stored value can pass for one. */
class RolledBack<V> {
  readonly value: V;
  constructor(value: V) {
    this.value = value;
  }
}

/** `withWriteScope` for a write that can refuse: a callback that returns `rollback(value)` gets the scope's writes undone
 *  and `value` back, with no throw. Any other return commits. */
export function withWriteScopeOr<T, R>(
  db: DatabaseSyncLike,
  name: string,
  fn: (rollback: <V>(value: V) => RolledBack<V>) => T | RolledBack<R>,
): T | R {
  const top = db.isTransaction === false;
  db.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  try {
    const result = fn((value) => new RolledBack(value));
    if (result instanceof RolledBack) {
      undoScope(db, top, name);
      return result.value;
    }
    db.exec(top ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { undoScope(db, top, name); } catch { /* already rolled back; keep the original error */ }
    throw error;
  }
}
