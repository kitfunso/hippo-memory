// What one hippo.db open may use. Only the SQLite adapter mints a grant
// (src/store/sqlite/grant.ts); openHippoDb without one is a plain connection of its own.
import { existsSync } from 'node:fs';
import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { defaultBusyWaitMs } from './busy.js';
import { connectWithFacts, getHippoDbPath, type OpenedDb } from './connect.js';
import { assertStoreFolder, openHippoDbReadOnly } from './open.js';
import { SESSION_OPEN, type RequestStores } from './request-stores.js';
import type { StoreRuntime } from './store-runtime.js';
import { SqliteBlockedError } from './sqlite-blocked.js';

const MINT = Symbol('hippo.db grant');

const WORKER_ONLY_MESSAGE =
  'hippo.db was opened on the server thread by a route whose SQLite work runs on a worker thread';

/** What a grant opens with. */
export interface GrantScope {
  /** Caches the store's open steps, lends idle handles and holds file writes; undefined starts
   * each open fresh. */
  readonly runtime: StoreRuntime | undefined;
  /** The request's own handles: an open reuses the session's handle on the same store. */
  readonly session: RequestStores | undefined;
  /** The server thread's part of a worker store: its work runs on worker threads, so an open
   * here is a defect. */
  readonly workerOnly: boolean;
}

/** The right to open hippo.db with a runtime, a request's session or a worker-thread fence. */
export class DbGrant {
  readonly #runtime: StoreRuntime | undefined;
  readonly #session: RequestStores | undefined;
  readonly #workerOnly: boolean;

  constructor(mint: symbol, scope: GrantScope) {
    if (mint !== MINT) throw new Error('hippo.db opens need a grant from the SQLite adapter');
    this.#runtime = scope.runtime;
    this.#session = scope.session;
    this.#workerOnly = scope.workerOnly;
  }

  get runtime(): StoreRuntime | undefined {
    return this.#runtime;
  }

  get session(): RequestStores | undefined {
    return this.#session;
  }

  /** A read-write handle; `busyWaitMs` shortens its lock waits, a session's own wait when
   * unset. */
  open(hippoRoot: string, busyWaitMs?: number): DatabaseSyncLike {
    return this.openWithFacts(hippoRoot, busyWaitMs).db;
  }

  /** `open`, with what the open's probe read when this call made the connection. */
  openWithFacts(hippoRoot: string, busyWaitMs?: number): OpenedDb {
    DbGrant.#allow(this, hippoRoot);
    const session = this.#session;
    if (session !== undefined) return session[SESSION_OPEN](hippoRoot, { busyWaitMs });
    return connectWithFacts({ hippoRoot, runtime: this.#runtime }, busyWaitMs);
  }

  /** An existing store, unchanged: no mkdir, WAL switch, migration or mirror cleanup. */
  openReadOnly(hippoRoot: string): DatabaseSyncLike {
    DbGrant.#allow(this, hippoRoot);
    return openHippoDbReadOnly(hippoRoot);
  }

  /** Runs `fn` on an existing hippo.db opened without migrations, for a repair of a store whose
   * schema is behind; closes it after. */
  withUnmigrated<T>(hippoRoot: string, readOnly: boolean, fn: (db: DatabaseSyncLike) => T): T {
    DbGrant.#allow(this, hippoRoot);
    const file = getHippoDbPath(hippoRoot);
    if (!existsSync(file)) throw new Error(`No existing Hippo database at ${file}`);
    const db = new DatabaseSync(file, { readOnly });
    try {
      db.exec(`PRAGMA busy_timeout = ${defaultBusyWaitMs()}`);
      return fn(db);
    } finally {
      db.close();
    }
  }

  // Static, so the brand check runs on a look-alike object before any private field is read.
  static #allow(grant: DbGrant, hippoRoot: string): void {
    if (!(#runtime in grant)) {
      throw new Error('hippo.db opens need a grant from the SQLite adapter');
    }
    if (grant.#workerOnly) throw new SqliteBlockedError('sqlite', WORKER_ONLY_MESSAGE);
    assertStoreFolder(hippoRoot);
  }
}

/** The one way to make a grant; only src/store/sqlite/grant.ts may call it. */
export function mintDbGrant(scope: GrantScope): DbGrant {
  return new DbGrant(MINT, scope);
}
