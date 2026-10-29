import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';
import { assertBinaryCompatible } from './migrate.js';
import { DEFAULT_BUSY_WAIT_MS } from './busy.js';
import { connectWithFacts, getHippoDbPath } from './connect.js';
import { sessionOf, type RequestStores } from './request-stores.js';
import { OtherStoreFolderError } from './sqlite-blocked.js';

export { getHippoDbPath };

/** Lock wait for hook commands: under the prompt hook's HOOK_SHORT_TIMEOUT_SECONDS budget even
 * after a few skipped writes, and far above a normal write's hold. */
export const HOOK_DB_WAIT_MS = 1000;

/** Lock wait inside an HTTP request: SQLite waits synchronously, so a long wait would stall
 * every other request on the event loop. */
export const SERVER_DB_WAIT_MS = 250;

/** A busy store made a command skip work: warn once per process (the holder is usually `hippo
 * sleep`); `session`, a hook's, then skips its later writes at once. */
export function noteStoreBusy(skipped: string, session?: RequestStores): void {
  log.once(
    'store-busy',
    'warn',
    `store busy (another hippo process holds the write lock); ${skipped}`,
  );
  session?.noteBusy();
}

/** Lock wait for each of sleep's short write transactions, even inside a server request: a run
 * stops only on a writer that holds the lock longer. */
export const SLEEP_DB_WAIT_MS = 5000;

/** store init --db, store copy --db and serve --db write this file in the hippo root; its text
 * is the store kind. */
export const OTHER_STORE_MARKER = 'other-store';

// An empty or unreadable marker still refuses: falling through would write the hippo.db the marker
// forbids.
function markerKind(marker: string): string {
  try {
    return readFileSync(marker, 'utf8').trim() || 'unknown';
  } catch (err) {
    log.warn(
      `${marker} is unreadable, so its store kind reads as unknown: ${errorMessage(err)}`,
      errorFields(err),
    );
    return 'unknown';
  }
}

/** Lock wait of an unscoped open. */
export interface OpenOptions {
  /** Shortens every lock wait of this open, for a hook that must finish inside its own timeout. */
  readonly busyWaitMs?: number | undefined;
}

/** Throws where a marker names another store kind; checked on every open, not cached, since the
 * marker can appear while a process runs. */
export function assertStoreFolder(hippoRoot: string): void {
  const marker = join(hippoRoot, OTHER_STORE_MARKER);
  if (existsSync(marker)) throw new OtherStoreFolderError(markerKind(marker), marker);
}

/** A connection of its own, with no runtime, session or worker fence: what scripts and tests open.
 * Code in src opens through its store's DbGrant. */
export function openHippoDb(hippoRoot: string, opts?: OpenOptions): DatabaseSyncLike {
  assertStoreFolder(hippoRoot);
  return connectWithFacts({ hippoRoot, runtime: undefined }, opts?.busyWaitMs).db;
}

/** Open an existing store without changing it: no mkdir, WAL switch, migration or mirror
 * cleanup. Throws when hippo.db is missing. */
export function openHippoDbReadOnly(hippoRoot: string): DatabaseSyncLike {
  assertStoreFolder(hippoRoot);
  const db = new DatabaseSync(getHippoDbPath(hippoRoot), { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_WAIT_MS}`);
    if (tableExists(db, 'meta')) assertBinaryCompatible(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch (closeErr) {
      log.error(
        `openHippoDbReadOnly: closing the handle after a failed open failed: ${errorMessage(closeErr)}`,
        errorFields(closeErr),
      );
    }
    throw error;
  }
}

export function closeHippoDb(db: DatabaseSyncLike): void {
  if (sessionOf(db) !== undefined) return;
  db.close();
}
