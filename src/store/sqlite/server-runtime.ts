// What a server serves hippo.db with, built in one place: the worker store, the connection held beside it, the global
// stores and the worker counts, so a server root never names the executor or the holder.
import { createHost, type Host } from '../../host/host.js';
import type { HippoStore, StoreReach } from '../../base/ports/store.js';
import { createSqliteExecutor, type ExecutorOptions } from './executor.js';
import { workerCounts } from './executor-counts.js';
import { isHippoDbStore } from './hippo-db-stores.js';
import { createStoreHolder, type StoreHolder } from './held-connection.js';
import { sqliteReach } from './store.js';
import { globalStoresFor, storeForRequest, workerSqliteStore } from './worker-store.js';
import { StoreRuntime } from '../../db/store-runtime.js';
import type { RequestLimits } from '../../base/util/request-scope.js';

export interface ServerRuntimeOptions extends ExecutorOptions {
  /** Served in place of hippo.db's worker store; the caller built it, so close() leaves it open. */
  readonly store?: HippoStore | undefined;
  /** The server root's Host, which every request's reach probes through. */
  readonly host?: Host | undefined;
}

/** The served store and what a listener calls around each response; close() ends it all, the held connection last. */
export interface SqliteServerRuntime extends Omit<StoreHolder, 'release'> {
  readonly store: HippoStore;
  /** The Host this server root keeps for its life; its ports and every reach share it. */
  readonly host: Host;
  /** The store is hippo.db rather than a caller's own, so its folder's config.json decides shared-ness. */
  readonly onHippoDb: boolean;
  /** The served store as one request calls it: each call to a worker carries the request's deadline and signal. */
  readonly storeFor: <S extends HippoStore>(store: S, limits: RequestLimits) => S;
  /** What a request's store call reaches, probed per request (`shared` is the transport's flag). */
  readonly reachOf: (shared: boolean, limits: RequestLimits) => StoreReach;
  /** What the store workers of this process refused, expired and replaced; /health reports them. */
  readonly workerCounts: Readonly<typeof workerCounts>;
  readonly close: () => Promise<void>;
  /** What the root's exit hook runs when the process exits before close(): the held writes and handles of the server's
   * store runtime. */
  readonly closeOnExit: () => void;
}

/** hippo.db under `hippoRoot` as a server runs it: `opts.store` when given, else a worker store on `opts`' executor. */
export function sqliteServerRuntime(hippoRoot: string, opts: ServerRuntimeOptions = {}): SqliteServerRuntime {
  const { store: given, host = createHost(), ...executorOpts } = opts;
  // The server's own, even under `hippo serve`: the executor, the holder and the global stores share its checkpoint
  // state, and a CLI root's runtime ends with its command.
  const runtime = new StoreRuntime();
  const rules = { ...executorOpts, runtime };
  const store = given ?? workerSqliteStore(hippoRoot, createSqliteExecutor(hippoRoot, rules), rules);
  const globalStores = globalStoresFor(store, rules);
  const holder = createStoreHolder(hippoRoot, store, runtime);
  return {
    store,
    host,
    onHippoDb: isHippoDbStore(store),
    storeFor: storeForRequest,
    reachOf: (shared, limits) =>
      sqliteReach(hippoRoot, store, shared, (root) => storeForRequest(globalStores.open(root), limits), host),
    workerCounts,
    hold: holder.hold,
    afterResponse: holder.afterResponse,
    close: async () => {
      // The store's worker threads and the pooled handles close first, so the held one is still SQLite's last.
      if (given === undefined) await store.close();
      await globalStores.close();
      runtime.dispose();
      await holder.release();
    },
    closeOnExit: () => runtime.dispose(),
  };
}
