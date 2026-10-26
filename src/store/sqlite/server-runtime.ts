// What a server serves hippo.db with, built in one place: the worker store, the connection held
// beside it, the global stores and the worker counts, so a server root never names the executor or
// the holder.
import { createHost, type Host } from '../../host/host.js';
import type { HippoStore, StoreReach } from '../../base/ports/store.js';
import { createSqliteExecutor, type ExecutorOptions } from './executor.js';
import { workerCounts } from './executor-counts.js';
import { isHippoDbStore } from './hippo-db-stores.js';
import {
  createStoreHolder,
  offLoopFor,
  outsideRouteBlock,
  type StoreHolder,
} from './held-connection.js';
import { sqliteReach } from './store.js';
import { globalStoresFor, workerSqliteStore } from './worker-store.js';
import { currentStoreRuntime, StoreRuntime } from '../../db/store-runtime.js';

export interface ServerRuntimeOptions extends ExecutorOptions {
  /** Served in place of hippo.db's worker store; the caller built it, so close() leaves it open. */
  readonly store?: HippoStore | undefined;
  /** The server root's Host, which every request's reach probes through. */
  readonly host?: Host | undefined;
}

/** The served store and what a listener calls around each response; close() ends it all, the
 * held connection last. */
export interface SqliteServerRuntime extends Omit<StoreHolder, 'release'> {
  readonly store: HippoStore;
  /** The Host this server root keeps for its life; its ports and every reach share it. */
  readonly host: Host;
  /** The store is hippo.db rather than a caller's own, so its folder's config.json decides
   * shared-ness. */
  readonly onHippoDb: boolean;
  /** What a request's store call reaches, probed per request (`shared` is the transport's flag). */
  readonly reachOf: (shared: boolean) => StoreReach;
  /** Fences a loop-off route's work from hippo.db on the server thread when the store has
   * workers. */
  readonly offLoop: <T>(run: () => T) => T;
  readonly outsideRouteBlock: typeof outsideRouteBlock;
  /** What the store workers of this process refused, expired and replaced; /health reports them. */
  readonly workerCounts: Readonly<typeof workerCounts>;
  readonly close: () => Promise<void>;
  /** What the root's exit hook runs when the process exits before close(): the held writes and
   * handles of a store runtime this server opened. */
  readonly closeOnExit: () => void;
}

function servedStores(
  hippoRoot: string,
  given: HippoStore | undefined,
  executorOpts: ExecutorOptions,
) {
  const served =
    given ??
    workerSqliteStore(hippoRoot, createSqliteExecutor(hippoRoot, executorOpts), executorOpts);
  return {
    store: served,
    globalStores: globalStoresFor(served, executorOpts),
    holder: createStoreHolder(hippoRoot, served),
  };
}

/** hippo.db under `hippoRoot` as a server runs it: `opts.store` when given, else a worker store
 * on `opts`' executor. */
export function sqliteServerRuntime(
  hippoRoot: string,
  opts: ServerRuntimeOptions = {},
): SqliteServerRuntime {
  const { store: given, host = createHost(), ...executorOpts } = opts;
  // The root's runtime when the server starts inside one (`hippo serve`), else the server's own;
  // every request runs in it, so the requests share its idle handles.
  const joined = currentStoreRuntime();
  const stores = joined ?? new StoreRuntime();
  // Built inside the runtime, so the executor and the holder share its checkpoint state.
  const { store, globalStores, holder } = stores.run(() =>
    servedStores(hippoRoot, given, executorOpts),
  );
  return {
    store,
    host,
    onHippoDb: isHippoDbStore(store),
    reachOf: (shared) => sqliteReach(hippoRoot, store, shared, globalStores.open, host),
    offLoop: offLoopFor(store),
    outsideRouteBlock,
    workerCounts,
    hold: holder.hold,
    afterResponse: holder.afterResponse,
    runRequest: (run) => stores.run(() => holder.runRequest(run)),
    close: async () => {
      // The store's worker threads and the pooled handles close first, so the held one is still
      // SQLite's last.
      if (given === undefined) await store.close();
      await globalStores.close();
      if (joined) {
        joined.held.flush(hippoRoot);
        joined.closeIdle();
      } else stores.dispose();
      await holder.release();
    },
    closeOnExit: () => {
      if (!joined) stores.dispose();
    },
  };
}
