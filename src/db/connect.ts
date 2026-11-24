import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupArchivedMirrors } from './raw-archive-mirror-cleanup.js';
import { errorCode, errorFields, errorMessage, log } from '../base/util/log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { DEFAULT_BUSY_WAIT_MS, execWithBusyRetry } from './busy.js';
import {
  type OpenFacts,
  currentStoreFacts,
  importLegacyVectors,
  runMigrations,
  settledStoreFacts,
} from './migrate.js';
import { autoCheckpointPages } from './wal-checkpointer.js';
import { storeKey, type StoreRuntime } from './store-runtime.js';
import { PRIVATE_DIR } from '../host/private-dir.js';
import { ensureKeyGitignored } from '../host/key-gitignore.js';

export function getHippoDbPath(hippoRoot: string): string {
  return path.join(hippoRoot, 'hippo.db');
}

/** A store's folder and the runtime its opens run under; undefined runs every open step on every
 * open. */
export interface StoreAt {
  readonly hippoRoot: string;
  readonly runtime: StoreRuntime | undefined;
}

/** Runs `step` on the store unless it already ran to the end under the store's runtime; a throw
 * leaves it due, and with no runtime it always runs. */
export function oncePerStore(
  { hippoRoot, runtime }: StoreAt,
  name: string,
  step: () => void,
): void {
  const key = storeKey(hippoRoot);
  if (runtime?.hasRun(key, name)) return;
  step();
  runtime?.markRun(key, name);
}

function createStoreFilesOwnerOnly(at: StoreAt): void {
  const { hippoRoot } = at;
  if (fs.existsSync(getHippoDbPath(hippoRoot))) {
    oncePerStore(at, 'mode-check', () => warnWideModes(hippoRoot));
    return;
  }
  fs.mkdirSync(hippoRoot, PRIVATE_DIR);
  ensureKeyGitignored(hippoRoot);
  try {
    fs.closeSync(fs.openSync(getHippoDbPath(hippoRoot), 'wx', 0o600));
    at.runtime?.forget(storeKey(hippoRoot));
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
  }
}

function warnWideModes(hippoRoot: string): void {
  if (process.platform === 'win32') return;
  const wide = [
    { file: hippoRoot, limit: 0o700 },
    { file: getHippoDbPath(hippoRoot), limit: 0o600 },
  ].filter(({ file, limit }) => (fs.statSync(file).mode & 0o777 & ~limit) !== 0);
  for (const { file, limit } of wide) {
    const mode = (fs.statSync(file).mode & 0o777).toString(8);
    log.once(
      `store-mode:${file}`,
      'warn',
      `${file} has mode ${mode}, wider than ${limit.toString(8)}; run chmod ${limit.toString(8)} ${file}`,
    );
  }
}

function sweepArchivedMirrorsIfDue(
  hippoRoot: string,
  db: DatabaseSyncLike,
  pending: boolean | undefined,
): void {
  if (pending !== false) cleanupArchivedMirrors(hippoRoot, db);
}

const SCHEMA_STEP = 'schema';

const gated = new WeakSet<DatabaseSyncLike>();

/** Whether `db` is behind the write gate, so it refuses every write. */
export function isReadOnlyHandle(db: DatabaseSyncLike): boolean {
  return gated.has(db);
}

/** Runs `fn` with the gate open on `db`: a temp table lives in no store file. */
export function withTempTables<T>(db: DatabaseSyncLike, fn: () => T): T {
  if (!gated.has(db)) return fn();
  db.exec('PRAGMA query_only = OFF');
  try {
    return fn();
  } finally {
    db.exec('PRAGMA query_only = ON');
  }
}

/** Makes the next connection under `runtime` prove this store's schema again; `hippo init` calls
 * it because it is the explicit ask to set a store up. */
export function reproveStoreSchema({ hippoRoot, runtime }: StoreAt): void {
  runtime?.forget(storeKey(hippoRoot), SCHEMA_STEP);
}

function settleSchema(db: DatabaseSyncLike, at: StoreAt, busyWaitMs: number): OpenFacts | null {
  const { hippoRoot, runtime } = at;
  if (runtime?.hasRun(storeKey(hippoRoot), SCHEMA_STEP)) {
    const settled = settledStoreFacts(db);
    if (settled) {
      importLegacyVectors(db, hippoRoot);
      return settled;
    }
  }
  const facts = runMigrations(db, hippoRoot, busyWaitMs);
  oncePerStore(at, SCHEMA_STEP, () => undefined);
  return facts;
}

/** Refuses every write on `db`; only withTempTables opens it again, and only for a temp table. */
export function shutWriteGate(db: DatabaseSyncLike): void {
  db.exec('PRAGMA query_only = ON');
  gated.add(db);
}

function closeGate(db: DatabaseSyncLike, facts: OpenFacts | null): OpenedDb {
  shutWriteGate(db);
  return { db, facts };
}

function emptyReadOnlyStore(busyWaitMs: number): OpenedDb {
  const db = new DatabaseSync(':memory:');
  try {
    return closeGate(db, runMigrations(db, undefined, busyWaitMs));
  } catch (error) {
    db.close();
    throw error;
  }
}

function walReadOnlyStore(hippoRoot: string, busyWaitMs: number): OpenedDb | null {
  const file = getHippoDbPath(hippoRoot);
  if (!fs.existsSync(`${file}-wal`)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  let facts: OpenFacts | null;
  try {
    db.exec(`PRAGMA busy_timeout = ${busyWaitMs}`);
    db.exec('PRAGMA foreign_keys = ON');
    facts = currentStoreFacts(db);
    if (facts !== null) return closeGate(db, facts);
  } catch (error) {
    db.close();
    throw error;
  }
  db.close();
  return null;
}

const READ_WRITE_GATE = 'read-only-via-read-write';

function readOnlyStore(at: StoreAt, busyWaitMs: number): OpenedDb | null {
  const { hippoRoot, runtime } = at;
  if (!fs.existsSync(getHippoDbPath(hippoRoot))) return emptyReadOnlyStore(busyWaitMs);
  if (runtime?.hasRun(storeKey(hippoRoot), READ_WRITE_GATE)) return null;
  const opened = walReadOnlyStore(hippoRoot, busyWaitMs);
  if (opened === null) runtime?.markRun(storeKey(hippoRoot), READ_WRITE_GATE);
  return opened;
}

/**
 * A connection with what its own open's probe read; facts go stale with the next statement, so a
 * handle made by an earlier call carries null.
 */
export interface OpenedDb {
  readonly db: DatabaseSyncLike;
  readonly facts: OpenFacts | null;
  readonly reused?: boolean;
}

/**
 * A new connection with the store's pragmas and migrations applied and the mirror cleanup run when
 * it is due; the caller owns and closes it. `busyWaitMs` is the default lock wait when unset. An
 * open with no session takes this path; a session's first open on a store does too.
 */
export function connectWithFacts(at: StoreAt, busyWaitMs: number = DEFAULT_BUSY_WAIT_MS): OpenedDb {
  const { hippoRoot } = at;
  const readOnly = at.runtime?.readOnly === true;
  const settled = readOnly ? readOnlyStore(at, busyWaitMs) : null;
  if (settled !== null) return settled;
  createStoreFilesOwnerOnly(at);
  const db = new DatabaseSync(getHippoDbPath(hippoRoot));
  try {
    db.exec(`PRAGMA busy_timeout = ${busyWaitMs}`);
    execWithBusyRetry(db, 'PRAGMA journal_mode = WAL', busyWaitMs);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(
      `PRAGMA wal_autocheckpoint = ${autoCheckpointPages(getHippoDbPath(hippoRoot), at.runtime)}`,
    );
    db.exec('PRAGMA foreign_keys = ON');
    const facts = settleSchema(db, at, busyWaitMs);
    if (readOnly) return closeGate(db, facts);
    try {
      sweepArchivedMirrorsIfDue(hippoRoot, db, facts?.archivePending);
    } catch (cleanupErr) {
      log.error(
        `openHippoDb: cleanupArchivedMirrors failed (non-fatal): ${errorMessage(cleanupErr)}`,
        errorFields(cleanupErr),
      );
    }
    return { db, facts };
  } catch (error) {
    try {
      db.close();
    } catch (closeErr) {
      log.error(
        `openHippoDb: closing the handle after a failed open failed: ${errorMessage(closeErr)}`,
        errorFields(closeErr),
      );
    }
    throw error;
  }
}
