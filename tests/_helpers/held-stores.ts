// A test's stores stay held open until the test ends, as `hippo serve` holds its store: no store call's close is then
// SQLite's last, which checkpoints the WAL with two fsyncs and deletes it, and the next write syncs a new WAL header.
import { DatabaseSync, type DatabaseSyncLike } from '../../src/db/sqlite.js';
import { getHippoDbPath } from '../../src/db/open.js';

// On globalThis, so the runner and the test file share one list whichever module copy each imports.
const KEY = Symbol.for('hippo.test.heldStores');
const held: Map<string, DatabaseSyncLike> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map()) as Map<
  string,
  DatabaseSyncLike
>;

/** Holds the store under `hippoRoot` open until the running test ends (tests/_held-stores-runner.ts). */
export function holdUntilTestEnds(hippoRoot: string): void {
  const file = getHippoDbPath(hippoRoot);
  if (held.has(file)) return;
  const db = new DatabaseSync(file);
  // A read opens the WAL and takes the shared lock that keeps every other close from being the last.
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  held.set(file, db);
}

/** Closes every held store, so the test's own cleanup can remove its folders; Windows refuses to delete an open file. */
export function releaseHeldStores(): void {
  for (const db of held.values()) db.close();
  held.clear();
}
