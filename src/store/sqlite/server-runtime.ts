// What a server serves hippo.db with, built in one place: the worker store, the connection held beside it, the global
// stores and the worker counts, so a server root never names the executor or the holder.
import type { HippoStore, StoreReach } from '../port.js';
import { createSqliteExecutor, type ExecutorOptions } from './executor.js';
import { workerCounts } from './executor-counts.js';
import { createStoreHolder, offLoopFor, outsideRouteBlock, type StoreHolder } from './held-connection.js';
import { sqliteReach } from './store.js';
import { globalStoresFor, workerSqliteStore } from './worker-store.js';

export interface ServerRuntimeOptions extends ExecutorOptions {
  /** Served in place of hippo.db's worker store; the caller built it, so close() leaves it open. */
  readonly store?: HippoStore | undefined;
}

/** The served store and what a listener calls around each response; close() ends it all, the held connection last. */
export interface SqliteServerRuntime extends Omit<StoreHolder, 'release'> {
  readonly store: HippoStore;
  /** What a request's store call reaches, probed per request (`shared` is the transport's flag). */
  readonly reachOf: (shared: boolean) => StoreReach;
  /** Fences a loop-off route's work from hippo.db on the server thread when the store has workers. */
  readonly offLoop: <T>(run: () => T) => T;
  readonly outsideRouteBlock: typeof outsideRouteBlock;
  /** What the store workers of this process refused, expired and replaced; /health reports them. */
  readonly workerCounts: Readonly<typeof workerCounts>;
  readonly close: () => Promise<void>;
}

/** hippo.db under `hippoRoot` as a server runs it: `opts.store` when given, else a worker store on `opts`' executor. */
export function sqliteServerRuntime(hippoRoot: string, opts: ServerRuntimeOptions = {}): SqliteServerRuntime {
  const { store: given, ...executorOpts } = opts;
  const store = given ?? workerSqliteStore(hippoRoot, createSqliteExecutor(hippoRoot, executorOpts), executorOpts);
  const globalStores = globalStoresFor(store, executorOpts);
  const holder = createStoreHolder(hippoRoot, store);
  return {
    store,
    reachOf: (shared) => sqliteReach(hippoRoot, store, shared, globalStores.open),
    offLoop: offLoopFor(store),
    outsideRouteBlock,
    workerCounts,
    hold: holder.hold,
    afterResponse: holder.afterResponse,
    runRequest: holder.runRequest,
    close: async () => {
      // The store's worker threads close their connections first, so the held one is still SQLite's last.
      if (given === undefined) await store.close();
      await globalStores.close();
      await holder.release();
    },
  };
}
