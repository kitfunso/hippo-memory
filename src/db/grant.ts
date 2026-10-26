// What one hippo.db open may use. Only the SQLite adapter mints a grant (src/store/sqlite/grant.ts); an open without one
// is a plain connection of its own.
import type { RequestStores } from './request-stores.js';
import type { StoreRuntime } from './store-runtime.js';

declare const minted: unique symbol;

export interface DbGrant {
  readonly [minted]: true;
  /** Caches the store's open steps, lends idle handles and holds file writes; undefined starts each open fresh. */
  readonly runtime: StoreRuntime | undefined;
  /** The request's own handles: an open reuses the session's handle on the same store. */
  readonly session: RequestStores | undefined;
  /** The server thread's part of a worker store: its work runs on worker threads, so an open here is a defect. */
  readonly workerOnly: boolean;
}

export interface OpenOptions {
  /** Lock wait of this open; a session's own wait when unset. */
  readonly busyWaitMs?: number | undefined;
  readonly grant?: DbGrant | undefined;
}
