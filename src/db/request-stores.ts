import { errorFields, errorMessage, log } from '../base/util/log.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { connectWithFacts, type OpenedDb } from './connect.js';
import { settledStoreFacts } from './migrate.js';
import { storeKey, type StoreRuntime } from './store-runtime.js';

export interface RequestStoresOptions {
  readonly runtime?: StoreRuntime | undefined;
  readonly busyWaitMs?: number | undefined;
  readonly failFastWhenBusy?: boolean;
  readonly setupDoneFor?: string;
}

/** The session's open, which only a DbGrant (src/db/grant.ts) calls; .oxlintrc.json bans its import
 * elsewhere, so every hippo.db open on a session goes through a grant. */
export const SESSION_OPEN = Symbol('request session open');

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

  [SESSION_OPEN](hippoRoot: string, opts?: { busyWaitMs?: number | undefined }): OpenedDb {
    const busyWaitMs = opts?.busyWaitMs ?? this.busyWaitMs;
    const at = { hippoRoot, runtime: this.runtime };
    if (this.#closed) return connectWithFacts(at, busyWaitMs);
    const key = `${storeKey(hippoRoot)}\0${busyWaitMs ?? ''}`;
    const cached = this.#handles.get(key);
    if (cached?.isOpen && !cached.isTransaction) return { db: cached, facts: null, reused: true };
    if (cached?.isOpen) return connectWithFacts(at, busyWaitMs);
    const opened = this.#borrowed(key) ?? connectWithFacts(at, busyWaitMs);
    this.#handles.set(key, opened.db);
    owners.set(opened.db, this);
    this.runtime?.track(this);
    return opened;
  }

  #pooled(): boolean {
    return !this.#failFastWhenBusy;
  }

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

  #returned(key: string, db: DatabaseSyncLike): boolean {
    const runtime = this.runtime;
    if (!runtime || !this.#pooled() || db.isOpen === false || db.isTransaction) return false;
    owners.delete(db);
    if (runtime.giveIdle(key, db)) return true;
    owners.set(db, this);
    return false;
  }

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
