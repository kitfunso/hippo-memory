// A test's stores stay held open until the test ends, as `hippo serve` holds its store: no store call's close is then
// SQLite's last, which checkpoints the WAL with two fsyncs and deletes it, and the next write syncs a new WAL header.
import { resolve, sep } from 'node:path';
import { DatabaseSync, type DatabaseSyncLike } from '../../src/db/sqlite.js';
import { getHippoDbPath } from '../../src/db/open.js';

declare global {
  // On globalThis: tests/_held-stores-setup.ts wraps node:fs once per worker, and each test file loads this module anew.
  var hippoHeldStores: Map<string, DatabaseSyncLike> | undefined;
}
const held = (globalThis.hippoHeldStores ??= new Map());

/** Holds the store under `hippoRoot` open until the running test ends (tests/_held-stores-setup.ts). */
export function holdUntilTestEnds(hippoRoot: string): void {
  const file = resolve(getHippoDbPath(hippoRoot));
  if (held.has(file)) return;
  const db = new DatabaseSync(file);
  // A read opens the WAL and takes the shared lock that keeps every other close from being the last.
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  held.set(file, db);
}

/** Closes the held stores at or under `path`, or whose -wal or -shm file it is; every one without it. A test that
 *  checks what the last close leaves calls it first. */
export function releaseHeldStores(path?: string): void {
  const at = path === undefined ? undefined : resolve(path);
  for (const [file, db] of held) {
    if (at !== undefined && file !== at && !file.startsWith(at + sep) && !at.startsWith(`${file}-`)) continue;
    db.close();
    held.delete(file);
  }
}
