import * as fs from 'fs';
import * as path from 'path';
import { cleanupArchivedMirrors } from '../raw-archive-mirror-cleanup.js';
import { log } from '../log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { execWithBusyRetry } from './busy.js';
import { runMigrations } from './migrate.js';
import { autoCheckpointPages } from './wal-checkpointer.js';

export function getHippoDbPath(hippoRoot: string): string {
  return path.join(hippoRoot, 'hippo.db');
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

/** A new connection with the store's pragmas, migrations and mirror cleanup applied; the caller owns and closes it. */
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
