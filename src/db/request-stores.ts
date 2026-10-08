// One store handle per store for each request (HTTP call, MCP tool call, scoped CLI command), opened lazily and closed with it.
import * as path from 'node:path';
import type { DatabaseSyncLike } from './sqlite.js';
import { connectHippoDb, getHippoDbPath } from './connect.js';
import { currentRequestId, requestScopes, type RequestScope } from '../request-scope.js';

export interface RequestStoresOptions {
  /** Lock wait of every open in the scope that does not pass its own. */
  readonly busyWaitMs?: number;
  /** Set for hook scopes: after one lock wait runs out, {@link RequestStores.noteBusy} makes the scope's later writes skip at once. */
  readonly failFastWhenBusy?: boolean;
}

// Handles a scope owns, so closeHippoDb leaves them open for the rest of the request.
const scopedHandles = new WeakSet<DatabaseSyncLike>();

// process.exit skips every finally, so one exit listener closes the handles of scopes still open.
const liveScopes = new Set<RequestStores>();
let exitListenerInstalled = false;

function closeLiveScopes(): void {
  for (const scope of liveScopes) scope.close();
}

function trackLive(scope: RequestStores): void {
  liveScopes.add(scope);
  if (exitListenerInstalled) return;
  process.on('exit', closeLiveScopes);
  exitListenerInstalled = true;
}

/** The handles one request opened, keyed by resolved store path and lock wait. */
export class RequestStores implements RequestScope {
  readonly busyWaitMs: number | undefined;
  // Taken from the scope this one opens inside, so the request's log lines keep their id.
  readonly requestId: string | undefined = currentRequestId();
  readonly #failFastWhenBusy: boolean;
  readonly #handles = new Map<string, DatabaseSyncLike>();
  #closed = false;

  constructor(opts: RequestStoresOptions = {}) {
    this.busyWaitMs = opts.busyWaitMs;
    this.#failFastWhenBusy = opts.failFastWhenBusy === true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The scope's handle on `hippoRoot`, opened on first use. `opts.busyWaitMs` overrides the scope's lock wait. */
  get(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
    const busyWaitMs = opts?.busyWaitMs ?? this.busyWaitMs;
    // A listener or timer that outlives its request still sees this scope, so it gets a connection of its own.
    if (this.#closed) return connectHippoDb(hippoRoot, busyWaitMs);
    const key = `${path.resolve(getHippoDbPath(hippoRoot))}\0${busyWaitMs ?? ''}`;
    const cached = this.#handles.get(key);
    if (cached?.isOpen && !cached.isTransaction) return cached;
    const db = connectHippoDb(hippoRoot, busyWaitMs);
    // An open nested inside a transaction gets its own connection, which its caller closes.
    if (cached?.isOpen) return db;
    this.#handles.set(key, db);
    scopedHandles.add(db);
    trackLive(this);
    return db;
  }

  /** A lock held past one full wait belongs to a long transaction, so a hook scope's later writes skip at once. */
  noteBusy(): void {
    if (!this.#failFastWhenBusy) return;
    for (const db of this.#handles.values()) {
      if (db.isOpen !== false) db.exec('PRAGMA busy_timeout = 0');
    }
  }

  close(): void {
    this.#closed = true;
    liveScopes.delete(this);
    for (const db of this.#handles.values()) {
      if (db.isOpen !== false) db.close();
    }
    this.#handles.clear();
  }
}

/** Runs `fn` in a request scope whose handles close when `fn` settles; inside an open scope `fn` joins it and `opts` is ignored. */
export async function runWithRequestStores<T>(fn: () => T | Promise<T>, opts?: RequestStoresOptions): Promise<T> {
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

/** The scope this code runs in, if any. A closed scope still answers: its `get` falls through to a plain open. */
export function currentRequestStores(): RequestStores | undefined {
  const scope = requestScopes.getStore();
  return scope instanceof RequestStores ? scope : undefined;
}

/** Runs `fn` outside every store scope, for a connection that must outlive the request that happens to open it; its log lines keep the request's id. */
export function outsideRequestStores<T>(fn: () => T): T {
  return requestScopes.run({ requestId: currentRequestId() }, fn);
}

/** Whether a scope owns `db` and will close it itself. */
export function isScopedHandle(db: DatabaseSyncLike): boolean {
  return scopedHandles.has(db);
}
