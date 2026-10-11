import { errorFields, errorMessage, log } from '../util/log.js';
import type { DatabaseSyncLike } from './sqlite.js';

function carriesErrcode(cause: unknown): cause is { errcode: unknown } {
  return typeof cause === 'object' && cause !== null && 'errcode' in cause;
}

export function isSqliteBusy(cause: unknown): boolean {
  const code = carriesErrcode(cause) ? cause.errcode : undefined;
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

/** The lock wait of an open that names none: its busy_timeout and every explicit wait below. */
export const DEFAULT_BUSY_WAIT_MS = 5000;

// busy_timeout covers neither contended statement here: SQLite skips the busy handler for `PRAGMA journal_mode` and for a write
// that upgrades a deferred read snapshot, so both need an explicit wait.
export function execWithBusyRetry(db: DatabaseSyncLike, sql: string, timeoutMs = DEFAULT_BUSY_WAIT_MS): void {
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

/** Undo after a failure without letting a failed undo replace the caller's error; an idle handle means SQLite already unwound the scope. */
function undoAfterFailure(db: DatabaseSyncLike, top: boolean, name: string): void {
  if (db.isTransaction === false) return;
  try {
    undoScope(db, top, name);
  } catch (undoError) {
    log.error(`rollback of write scope ${name} failed: ${errorMessage(undoError)}`, errorFields(undoError));
  }
}

/** Waits for the lock past busy_timeout when given; ignored inside a caller's transaction, which already holds it. */
export interface WriteScopeOptions {
  readonly busyWaitMs?: number;
}

/** Runs `fn` as one write: BEGIN IMMEDIATE on an idle handle, else SAVEPOINT `name` inside the caller's transaction.
 *  A deferred scope that reads first cannot wait out another writer, while BEGIN IMMEDIATE waits the open's busy_timeout. */
export function withWriteScope<T>(db: DatabaseSyncLike, name: string, fn: () => T, opts?: WriteScopeOptions): T {
  const top = db.isTransaction === false;
  if (top && opts) execWithBusyRetry(db, 'BEGIN IMMEDIATE', opts.busyWaitMs);
  else db.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(top ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    undoAfterFailure(db, top, name);
    throw error;
  }
}

/** Runs the reads in `fn` against one snapshot, so two statements cannot straddle another process's write. */
export function withReadSnapshot<T>(db: DatabaseSyncLike, fn: () => T): T {
  if (db.isTransaction !== false) return fn();
  db.exec('BEGIN');
  let result: T;
  try {
    result = fn();
  } catch (error) {
    try {
      db.exec('COMMIT');
    } catch (endError) {
      log.error(`ending read snapshot failed: ${errorMessage(endError)}`, errorFields(endError));
    }
    throw error;
  }
  db.exec('COMMIT');
  return result;
}

/** Runs `fn` and undoes every write it made, throw or not: a dry run that reports what a real run would do. Takes no write lock up front. */
export function withTrialScope<T>(db: DatabaseSyncLike, name: string, fn: () => T): T {
  const top = db.isTransaction === false;
  db.exec(top ? 'BEGIN' : `SAVEPOINT ${name}`);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    undoAfterFailure(db, top, name);
    throw error;
  }
  undoScope(db, top, name);
  return result;
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
    undoAfterFailure(db, top, name);
    throw error;
  }
}
