import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupArchivedMirrors } from './raw-archive-mirror-cleanup.js';
import { errorCode, errorFields, errorMessage, log } from '../base/util/log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { DEFAULT_BUSY_WAIT_MS, execWithBusyRetry } from './busy.js';
import {
  type OpenFacts,
  importLegacyVectors,
  runMigrations,
  settledStoreFacts,
} from './migrate.js';
import { autoCheckpointPages } from './wal-checkpointer.js';
import { currentStoreRuntime, storeKey } from './store-runtime.js';
import { PRIVATE_DIR } from '../host/private-dir.js';

export function getHippoDbPath(hippoRoot: string): string {
  return path.join(hippoRoot, 'hippo.db');
}

/** Runs `step` on this store unless it already ran to the end under the current store runtime; a
 * throw leaves it due, and outside every runtime it always runs. */
export function oncePerStore(hippoRoot: string, name: string, step: () => void): void {
  const runtime = currentStoreRuntime();
  const key = storeKey(hippoRoot);
  if (runtime?.hasRun(key, name)) return;
  step();
  runtime?.markRun(key, name);
}

// Owner-only on create; SQLite gives the WAL and SHM files the db's mode. Existing paths keep
// theirs, with one warning.
function createStoreFilesOwnerOnly(hippoRoot: string): void {
  // A stat, not a failed exclusive open, is what an existing store costs on every connection.
  if (fs.existsSync(getHippoDbPath(hippoRoot))) {
    oncePerStore(hippoRoot, 'mode-check', () => warnWideModes(hippoRoot));
    return;
  }
  fs.mkdirSync(hippoRoot, PRIVATE_DIR);
  try {
    fs.closeSync(fs.openSync(getHippoDbPath(hippoRoot), 'wx', 0o600));
    currentStoreRuntime()?.forget(storeKey(hippoRoot));
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
  }
}

// Windows reports no owner-only bits, so only a POSIX mode can be too wide.
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

// The probe read whether an archived row's mirror waits for cleanup, so a clean archive costs no
// scan; a failed unlink leaves its row uncleaned, and the next open retries it.
function sweepArchivedMirrorsIfDue(
  hippoRoot: string,
  db: DatabaseSyncLike,
  pending: boolean | undefined,
): void {
  if (pending !== false) cleanupArchivedMirrors(hippoRoot, db);
}

const SCHEMA_STEP = 'schema';

/** Makes the next connection to this store prove its schema again; `hippo init` calls it because
 * it is the explicit ask to set a store up. */
export function reproveStoreSchema(hippoRoot: string): void {
  currentStoreRuntime()?.forget(storeKey(hippoRoot), SCHEMA_STEP);
}

// Once the runtime has proven a store's schema, a new connection re-reads only the two version
// stamps and the binary floor: a migration by another process moves a stamp and sends the open down
// the full path.
function settleSchema(
  db: DatabaseSyncLike,
  hippoRoot: string,
  busyWaitMs: number,
): OpenFacts | null {
  if (currentStoreRuntime()?.hasRun(storeKey(hippoRoot), SCHEMA_STEP)) {
    const settled = settledStoreFacts(db);
    if (settled) {
      // An older binary can still write embeddings.json beside a store this process has proven.
      importLegacyVectors(db, hippoRoot);
      return settled;
    }
  }
  const facts = runMigrations(db, hippoRoot, busyWaitMs);
  oncePerStore(hippoRoot, SCHEMA_STEP, () => undefined);
  return facts;
}

/**
 * A connection with what its own open's probe read; facts go stale with the next statement, so a
 * handle made by an earlier call carries null.
 */
export interface OpenedDb {
  readonly db: DatabaseSyncLike;
  readonly facts: OpenFacts | null;
  /** The request's own handle again: its first open already ran the once-per-open steps. */
  readonly reused?: boolean;
}

/**
 * A new connection with the store's pragmas and migrations applied and the mirror cleanup run when
 * it is due; the caller owns and closes it. Outside any request scope (CLI start-up, timers) this
 * is the only handle there is; openHippoDb reuses the scope's when one exists.
 */
export function connectWithFacts(
  hippoRoot: string,
  busyWaitMs: number = DEFAULT_BUSY_WAIT_MS,
): OpenedDb {
  createStoreFilesOwnerOnly(hippoRoot);
  const db = new DatabaseSync(getHippoDbPath(hippoRoot));
  try {
    db.exec(`PRAGMA busy_timeout = ${busyWaitMs}`);
    execWithBusyRetry(db, 'PRAGMA journal_mode = WAL', busyWaitMs);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages(getHippoDbPath(hippoRoot))}`);
    db.exec('PRAGMA foreign_keys = ON');
    const facts = settleSchema(db, hippoRoot, busyWaitMs);
    // Orphan mirrors of archived raw rows go here; a filesystem failure must not block the open.
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
