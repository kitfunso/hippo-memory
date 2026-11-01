// One store handle per store for each request (HTTP call, MCP tool call, scoped CLI command),
// opened lazily and closed with it. A store built with the session hands it to each of its opens.
import { errorFields, errorMessage, log } from '../base/util/log.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { connectWithFacts, type OpenedDb } from './connect.js';
import { settledStoreFacts } from './migrate.js';
import { storeKey, type StoreRuntime } from './store-runtime.js';

export interface RequestStoresOptions {
  /** Its pool lends and takes back the session's handles, and its exit closes a session still
   * open. */
  readonly runtime?: StoreRuntime | undefined;
  /** Lock wait of every open in the session that does not pass its own. */
  readonly busyWaitMs?: number | undefined;
  /** Set for hook sessions: after one lock wait runs out, noteBusy makes the session's later
   * writes skip at once. */
  readonly failFastWhenBusy?: boolean;
  /** A store whose open-time setup another connection already ran: a store worker's reader,
   * which cannot write it. */
  readonly setupDoneFor?: string;
}

/** The session's open, which only a DbGrant (src/db/grant.ts) calls; .oxlintrc.json bans its import
 * elsewhere, so every hippo.db open on a session goes through a grant. */
export const SESSION_OPEN = Symbol('request session open');

// The session that owns each handle, so closeHippoDb leaves it open for the rest of the request.
const owners = new WeakMap<DatabaseSyncLike, RequestStores>();

/** The handles one request opened, keyed by resolved store path and lock wait. */
export class RequestStores {
  readonly runtime: StoreRuntime | undefined;
  readonly busyWaitMs: number | undefined;
  readonly setupDoneFor: string | undefined;
  readonly #failFastWhenBusy: boolean;
  readonly #handles = new Map<string, DatabaseSyncLike>();
  #closed = false;

  constructor(opts: RequestStoresOptions = {}) {
    this.runtime = opts.runtime;
    this.busyWaitMs = opts.busyWaitMs;
    this.setupDoneFor = opts.setupDoneFor;
    this.#failFastWhenBusy = opts.failFastWhenBusy === true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The session's handle on `hippoRoot`, opened on first use, with the facts of the open's probe
   * (null for a cached handle); `opts.busyWaitMs` overrides the session's lock wait. */
  [SESSION_OPEN](hippoRoot: string, opts?: { busyWaitMs?: number | undefined }): OpenedDb {
    const busyWaitMs = opts?.busyWaitMs ?? this.busyWaitMs;
    const at = { hippoRoot, runtime: this.runtime };
    // A listener or timer that outlives its request still holds this session, so it gets a
    // connection of its own.
    if (this.#closed) return connectWithFacts(at, busyWaitMs);
    const key = `${storeKey(hippoRoot)}\0${busyWaitMs ?? ''}`;
    const cached = this.#handles.get(key);
    if (cached?.isOpen && !cached.isTransaction) return { db: cached, facts: null, reused: true };
    // An open nested inside a transaction gets its own connection, which its caller closes.
    if (cached?.isOpen) return connectWithFacts(at, busyWaitMs);
    const opened = this.#borrowed(key) ?? connectWithFacts(at, busyWaitMs);
    this.#handles.set(key, opened.db);
    owners.set(opened.db, this);
    this.runtime?.track(this);
    return opened;
  }

  // A hook session may cut its handles' lock wait to 0, so only other sessions borrow and return
  // pooled handles.
  #pooled(): boolean {
    return !this.#failFastWhenBusy;
  }

  // A pooled handle answers the settled check an open of a proven store runs, so a migration or a
  // raised binary floor since it was returned still sends the request down a fresh open.
  #borrowed(key: string): OpenedDb | undefined {
    const db = this.#pooled() ? this.runtime?.takeIdle(key) : undefined;
    if (db === undefined) return undefined;
    try {
      const facts = settledStoreFacts(db);
      if (facts) return { db, facts };
    } catch (err) {
      db.close();
      throw err;
    }
    db.close();
    return undefined;
  }

  // A handle at rest goes back to the runtime's pool, so the next request skips the open's pragmas
  // and prepares.
  #returned(key: string, db: DatabaseSyncLike): boolean {
    const runtime = this.runtime;
    if (!runtime || !this.#pooled() || db.isOpen === false || db.isTransaction) return false;
    owners.delete(db);
    if (runtime.giveIdle(key, db)) return true;
    owners.set(db, this);
    return false;
  }

  /** A lock held past one full wait belongs to a long transaction, so a hook session's later
   * writes skip at once. */
  noteBusy(): void {
    if (!this.#failFastWhenBusy) return;
    for (const db of this.#handles.values()) {
      if (db.isOpen !== false) db.exec('PRAGMA busy_timeout = 0');
    }
  }

  close(): void {
    this.#closed = true;
    this.runtime?.untrack(this);
    const failures: Error[] = [];
    for (const [key, db] of this.#handles) {
      try {
        if (!this.#returned(key, db) && db.isOpen !== false) db.close();
      } catch (err) {
        log.error(`request store ${key} did not close: ${errorMessage(err)}`, errorFields(err));
        failures.push(err instanceof Error ? err : new Error(errorMessage(err)));
      }
    }
    this.#handles.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `${failures.length} request stores did not close`);
    }
  }
}

/** Runs `fn` with a session of its own, whose handles close when `fn` settles. */
export async function withSharedStoreHandles<T>(
  fn: (session: RequestStores) => T | Promise<T>,
  opts?: RequestStoresOptions,
): Promise<T> {
  const session = new RequestStores(opts);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

/** withSharedStoreHandles for a synchronous `fn`, so a batch opens each store once. */
export function withSharedStoreHandlesSync<T>(
  fn: (session: RequestStores) => T,
  opts?: RequestStoresOptions,
): T {
  const session = new RequestStores(opts);
  try {
    return fn(session);
  } finally {
    session.close();
  }
}

/** The session that owns `db` and closes it itself; undefined for a handle its opener closes. */
export function sessionOf(db: DatabaseSyncLike): RequestStores | undefined {
  return owners.get(db);
}
