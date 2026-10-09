import * as fs from 'fs';
import * as path from 'path';
import { cleanupArchivedMirrors } from './raw-archive-mirror-cleanup.js';
import { errorMessage, log } from '../log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { execWithBusyRetry } from './busy.js';
import { runMigrations } from './migrate.js';
import { autoCheckpointPages } from './wal-checkpointer.js';

export function getHippoDbPath(hippoRoot: string): string {
  return path.join(hippoRoot, 'hippo.db');
}

// Per store file, what this process has already done to it; a store file created anew starts over.
const settledSteps = new Map<string, Set<string>>();
const sweptThrough = new Map<string, number>();

function storeKey(hippoRoot: string): string {
  return path.resolve(getHippoDbPath(hippoRoot));
}

/** Runs `step` on this store unless it already ran to the end in this process; a throw leaves it due. */
export function oncePerStore(hippoRoot: string, name: string, step: () => void): void {
  const key = storeKey(hippoRoot);
  const settled = settledSteps.get(key) ?? new Set<string>();
  if (settled.has(name)) return;
  step();
  settledSteps.set(key, settled.add(name));
}

// Owner-only on create; SQLite gives the WAL and SHM files the db's mode. Existing paths keep theirs.
function createStoreFilesOwnerOnly(hippoRoot: string): void {
  fs.mkdirSync(hippoRoot, { recursive: true, mode: 0o700 });
  try {
    fs.closeSync(fs.openSync(getHippoDbPath(hippoRoot), 'wx', 0o600));
    settledSteps.delete(storeKey(hippoRoot));
    sweptThrough.delete(storeKey(hippoRoot));
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
  }
}

// The archive only grows and its ids never repeat, so an unchanged top id means no row this process has not swept; a failed sweep stays due.
function sweepArchivedMirrorsIfDue(hippoRoot: string, db: DatabaseSyncLike): void {
  // SAFETY: MAX over the integer key returns one row with one column, null for an empty table.
  const row = db.prepare('SELECT MAX(id) AS top FROM raw_archive').get() as { top: number | null } | undefined;
  const top = Number(row?.top ?? 0);
  const key = storeKey(hippoRoot);
  if (sweptThrough.get(key) === top) return;
  if (cleanupArchivedMirrors(hippoRoot, db)) sweptThrough.set(key, top);
}

/** A new connection with the store's pragmas and migrations applied and the mirror cleanup run when it is due; the caller owns and closes it. */
export function connectHippoDb(hippoRoot: string, busyWaitMs?: number): DatabaseSyncLike {
  createStoreFilesOwnerOnly(hippoRoot);
  const db = new DatabaseSync(getHippoDbPath(hippoRoot));
  try {
    db.exec(`PRAGMA busy_timeout = ${busyWaitMs ?? 5000}`);
    execWithBusyRetry(db, 'PRAGMA journal_mode = WAL', busyWaitMs);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages(getHippoDbPath(hippoRoot))}`);
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, hippoRoot, busyWaitMs);
    // Orphan mirrors of archived raw rows go here; a filesystem failure must not block the open.
    try {
      sweepArchivedMirrorsIfDue(hippoRoot, db);
    } catch (cleanupErr) {
      log.error(`openHippoDb: cleanupArchivedMirrors failed (non-fatal): ${errorMessage(cleanupErr)}`);
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
