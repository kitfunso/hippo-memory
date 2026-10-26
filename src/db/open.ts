import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';
import { assertBinaryCompatible } from './migrate.js';
import { DEFAULT_BUSY_WAIT_MS } from './busy.js';
import { connectWithFacts, getHippoDbPath, type OpenedDb } from './connect.js';
import type { DbGrant, OpenOptions } from './grant.js';
import { sessionOf, type RequestStores } from './request-stores.js';
import { OtherStoreFolderError, SqliteBlockedError } from './sqlite-blocked.js';

export { getHippoDbPath };

/** Lock wait for hook commands: under the 5 s prompt-hook budget even after a few skipped writes, and far above a
 * normal write's hold. */
export const HOOK_DB_WAIT_MS = 1000;

/** Lock wait inside an HTTP request: SQLite waits synchronously, so a long wait would stall every other request on the
 * event loop. */
export const SERVER_DB_WAIT_MS = 250;

/** A busy store made a command skip work: warn once per process (the holder is usually `hippo sleep`); `session`, a
 * hook's, then skips its later writes at once. */
export function noteStoreBusy(skipped: string, session?: RequestStores): void {
  log.once('store-busy', 'warn', `store busy (another hippo process holds the write lock); ${skipped}`);
  session?.noteBusy();
}

/** Lock wait for each of sleep's short write transactions, even inside a server request: a run stops only on a writer
 * that holds the lock longer. */
export const SLEEP_DB_WAIT_MS = 5000;

const WORKER_ONLY_MESSAGE =
  'hippo.db was opened on the server thread by a route whose SQLite work runs on a worker thread';

/** store init --db, store copy --db and serve --db write this file in the hippo root; its text is the store kind. */
export const OTHER_STORE_MARKER = 'other-store';

// An empty or unreadable marker still refuses: falling through would write the hippo.db the marker forbids.
function markerKind(marker: string): string {
  try {
    return readFileSync(marker, 'utf8').trim() || 'unknown';
  } catch (err) {
    log.warn(`${marker} is unreadable, so its store kind reads as unknown: ${errorMessage(err)}`, errorFields(err));
    return 'unknown';
  }
}

/** Throws where hippo.db must not open; checked on every open, not cached, since the marker can appear while a process
 * runs. */
function assertSqliteAllowed(hippoRoot: string, grant: DbGrant | undefined): void {
  if (grant?.workerOnly === true) throw new SqliteBlockedError('sqlite', WORKER_ONLY_MESSAGE);
  const marker = join(hippoRoot, OTHER_STORE_MARKER);
  if (existsSync(marker)) throw new OtherStoreFolderError(markerKind(marker), marker);
}

/** `busyWaitMs` shortens every lock wait of this open, for a hook that must finish inside its own timeout; `grant` is
 * what the store that opens it holds. */
export function openHippoDb(hippoRoot: string, opts?: OpenOptions): DatabaseSyncLike {
  return openHippoDbWithFacts(hippoRoot, opts).db;
}

/** openHippoDb, with what the open's probe read when this call made the connection. */
export function openHippoDbWithFacts(hippoRoot: string, opts?: OpenOptions): OpenedDb {
  const grant = opts?.grant;
  assertSqliteAllowed(hippoRoot, grant);
  if (grant?.session !== undefined) return grant.session.getWithFacts(hippoRoot, opts);
  return connectWithFacts({ hippoRoot, runtime: grant?.runtime }, opts?.busyWaitMs);
}

/** Open an existing store without changing it: no mkdir, WAL switch, migration or mirror cleanup. Throws when hippo.db
 * is missing. */
export function openHippoDbReadOnly(hippoRoot: string, opts?: OpenOptions): DatabaseSyncLike {
  assertSqliteAllowed(hippoRoot, opts?.grant);
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

/** Runs `fn` on an existing hippo.db opened without migrations, for a repair of a store whose schema is behind; closes
 * it after. */
export function withUnmigratedDb<T>(
  hippoRoot: string,
  opts: { readonly readOnly: boolean; readonly grant?: DbGrant | undefined },
  fn: (db: DatabaseSyncLike) => T,
): T {
  // Skips openHippoDb, so it takes the same refusal itself.
  assertSqliteAllowed(hippoRoot, opts.grant);
  const file = getHippoDbPath(hippoRoot);
  if (!existsSync(file)) throw new Error(`No existing Hippo database at ${file}`);
  const db = new DatabaseSync(file, { readOnly: opts.readOnly });
  try {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_WAIT_MS}`);
    return fn(db);
  } finally {
    db.close();
  }
}

export function closeHippoDb(db: DatabaseSyncLike): void {
  if (sessionOf(db) !== undefined) return;
  db.close();
}
