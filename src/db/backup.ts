import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSyncLike } from './sqlite.js';
import { log } from '../util/log.js';

/** Copies the database before a repair writes, so the audit ids plus this file are the way back. */
export function backupStore(db: DatabaseSyncLike, hippoRoot: string, label: string, now = new Date()): string {
  const dir = path.join(hippoRoot, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `hippo-${label}-${now.toISOString().replace(/[:.]/g, '-')}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

/** Backs the store up, then runs one transaction; a transaction that throws rolled back, so its backup goes too. */
export function withBackup<T>(db: DatabaseSyncLike, hippoRoot: string, label: string, transaction: (backup: string) => T): T {
  const backup = backupStore(db, hippoRoot, label);
  try {
    return transaction(backup);
  } catch (err) {
    // A locked file on Windows must not hide why the transaction failed.
    try { fs.rmSync(backup, { force: true }); } catch (cleanupError) { log.warn(`Could not delete the unused backup ${backup}: ${String(cleanupError)}`); }
    throw err;
  }
}
