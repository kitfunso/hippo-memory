// One store handle per store for each request (HTTP call, MCP tool call, scoped CLI command),
// opened lazily and closed with it.
import { errorFields, errorMessage, log } from '../base/util/log.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { connectWithFacts, type OpenedDb } from './connect.js';
import { settledStoreFacts } from './migrate.js';
import { currentStoreRuntime, storeKey, type StoreRuntime } from './store-runtime.js';
import {
  currentDeadline,
  currentRequestId,
  currentSignal,
  requestScopes,
  type RequestScope,
} from '../base/util/request-scope.js';

export interface RequestStoresOptions {
  /** Lock wait of every open in the scope that does not pass its own. */
  readonly busyWaitMs?: number;
  /**
   * Set for hook scopes: after one lock wait runs out, {@link RequestStores.noteBusy} makes the
   * scope's later writes skip at once.
   *
   */
  readonly failFastWhenBusy?: boolean;
  /**
   * The store whose open-time setup another connection has already run, so an open in this scope
   * skips it: a store worker's reader, which cannot write it.
   *
   */
  readonly setupDoneFor?: string;
}

// Handles a scope owns, so closeHippoDb leaves them open for the rest of the request.
const scopedHandles = new WeakSet<DatabaseSyncLike>();

/** The handles one request opened, keyed by resolved store path and lock wait. */
export class RequestStores implements RequestScope {
  readonly busyWaitMs: number | undefined;
  // Taken from the scope this one opens inside, so the request's log lines keep their id.
  readonly requestId: string | undefined = currentRequestId();
  readonly deadline = currentDeadline();
  readonly signal = currentSignal();
  readonly setupDoneFor: string | undefined;
  readonly #failFastWhenBusy: boolean;
  readonly #handles = new Map<string, DatabaseSyncLike>();
  // The runtime the scope opened under: its exit closes the scope, and its pool lends and takes
  // back the handles.
  readonly #runtime: StoreRuntime | undefined = currentStoreRuntime();
  #closed = false;

  constructor(opts: RequestStoresOptions = {}) {
    this.busyWaitMs = opts.busyWaitMs;
    this.setupDoneFor = opts.setupDoneFor;
    this.#failFastWhenBusy = opts.failFastWhenBusy === true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The scope's handle on `hippoRoot`, opened on first use. `opts.busyWaitMs` overrides the
   * scope's lock wait. */
  get(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
    return this.getWithFacts(hippoRoot, opts).db;
  }

  /** `get`, with the facts of the open's probe when this call made the connection and null for a
   * cached handle. */
  getWithFacts(hippoRoot: string, opts?: { busyWaitMs?: number }): OpenedDb {
    const busyWaitMs = opts?.busyWaitMs ?? this.busyWaitMs;
    // A listener or timer that outlives its request still sees this scope, so it gets a connection
    // of its own.
    if (this.#closed) return connectWithFacts(hippoRoot, busyWaitMs);
    const key = `${storeKey(hippoRoot)}\0${busyWaitMs ?? ''}`;
    const cached = this.#handles.get(key);
    if (cached?.isOpen && !cached.isTransaction) return { db: cached, facts: null, reused: true };
    // An open nested inside a transaction gets its own connection, which its caller closes.
    if (cached?.isOpen) return connectWithFacts(hippoRoot, busyWaitMs);
    const opened = this.#borrowed(key) ?? connectWithFacts(hippoRoot, busyWaitMs);
    this.#handles.set(key, opened.db);
    scopedHandles.add(opened.db);
    this.#runtime?.track(this);
    return opened;
  }

  // A hook scope may cut its handles' lock wait to 0, so only other scopes borrow and return pooled
  // handles.
  #pooled(): boolean {
    return !this.#failFastWhenBusy;
  }

  // A pooled handle answers the settled check an open of a proven store runs, so a migration or a
  // raised binary floor since it was returned still sends the request down a fresh open.
  #borrowed(key: string): OpenedDb | undefined {
    const db = this.#pooled() ? this.#runtime?.takeIdle(key) : undefined;
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
    const runtime = this.#runtime;
    if (!runtime || !this.#pooled() || db.isOpen === false || db.isTransaction) return false;
    scopedHandles.delete(db);
    if (runtime.giveIdle(key, db)) return true;
    scopedHandles.add(db);
    return false;
  }

  /** A lock held past one full wait belongs to a long transaction, so a hook scope's later
   * writes skip at once. */
  noteBusy(): void {
    if (!this.#failFastWhenBusy) return;
    for (const db of this.#handles.values()) {
      if (db.isOpen !== false) db.exec('PRAGMA busy_timeout = 0');
    }
  }

  close(): void {
    this.#closed = true;
    this.#runtime?.untrack(this);
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
    if (failures.length > 1)
      throw new AggregateError(failures, `${failures.length} request stores did not close`);
  }
}

/**
 * Runs `fn` in a request scope whose handles close when `fn` settles; inside an open scope `fn`
 * joins it and `opts` is ignored.
 *
 */
export async function runWithRequestStores<T>(
  fn: () => T | Promise<T>,
  opts?: RequestStoresOptions,
): Promise<T> {
  const outer = currentRequestStores();
  if (outer && !outer.closed) return fn();
  const stores = new RequestStores(opts);
  return requestScopes.run(stores, async () => {
    try {
      return await fn();
    } finally {
      stores.close();
    }
  });
}

/**
 * runWithRequestStores for a synchronous `fn`, so a batch called from outside any request still
 * opens each store once.
 *
 */
export function withRequestStoresSync<T>(fn: () => T): T {
  const outer = currentRequestStores();
  if (outer && !outer.closed) return fn();
  const stores = new RequestStores();
  try {
    return requestScopes.run(stores, fn);
  } finally {
    stores.close();
  }
}

/** The scope this code runs in, if any. A closed scope still answers: its `get` falls through to
 * a plain open. */
export function currentRequestStores(): RequestStores | undefined {
  const scope = requestScopes.getStore();
  return scope instanceof RequestStores ? scope : undefined;
}

/**
 * Runs `fn` outside every store scope, for a connection that must outlive the request that happens
 * to open it; its log lines keep the request's id.
 *
 */
export function outsideRequestStores<T>(fn: () => T): T {
  return requestScopes.run({ requestId: currentRequestId() }, fn);
}

/** Whether a scope owns `db` and will close it itself. */
export function isScopedHandle(db: DatabaseSyncLike): boolean {
  return scopedHandles.has(db);
}
