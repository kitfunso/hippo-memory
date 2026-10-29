// What a server serves hippo.db with, built in one place: the worker store, the connection held
// beside it, the global stores and the worker counts, so a server root never names the executor or
// the holder.
import { createHost, type Host } from '../../../host/host.js';
import type { HippoStore, StoreReach } from '../../../base/ports/store.js';
import { createSqliteExecutor, type ExecutorOptions } from './executor.js';
import { workerCounts } from './executor-counts.js';
import { isHippoDbStore } from './hippo-db-stores.js';
import { createStoreHolder, type StoreHolder } from './held-connection.js';
import { inSqliteSession, sqliteReach } from '../store.js';
import { runSqliteRequest } from './request-scope.js';
import { globalStoresFor, storeForRequest, workerSqliteStore } from './worker-store.js';
import { StoreRuntime } from '../../../db/store-runtime.js';
import type { RequestStores } from '../../../db/index.js';
import type { RequestLimits } from '../../../base/util/request-scope.js';
import { log } from '../../../base/util/log.js';

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
  /** The served store as one request calls it: each call to a worker carries the request's
   * deadline and signal, and an in-process store opens on the request's session. */
  readonly storeFor: <S extends HippoStore>(
    store: S,
    limits: RequestLimits,
    session?: RequestStores,
  ) => S;
  /** What a request's store call reaches, probed per request (`shared` is the transport's flag). */
  readonly reachOf: (shared: boolean, limits: RequestLimits, session?: RequestStores) => StoreReach;
  /** Runs one request on a session of the server's runtime, so its in-process opens reuse the
   * runtime's idle handles. */
  readonly runRequest: <T>(run: (session: RequestStores) => Promise<T>) => Promise<T>;
  /** What the store workers of this process refused, expired and replaced; /health reports them. */
  readonly workerCounts: Readonly<typeof workerCounts>;
  /** Keeps the work a request starts and does not wait on, such as an embed; close() settles it. */
  readonly detached: Pick<StoreRuntime, 'detach'>;
  /** Waits up to `settleWithinMs` for the detached work, then closes the stores, the held
   * connection last. */
  readonly close: (settleWithinMs: number) => Promise<void>;
  /** What the root's exit hook runs when the process exits before close(): the held writes and
   * handles of the server's store runtime. */
  readonly closeOnExit: () => void;
}

/** `own` as one request calls it: worker calls carry the request's limits, and an in-process
 * store opens on its session. */
function boundToRequest<S extends HippoStore>(
  own: S,
  limits: RequestLimits,
  session?: RequestStores,
): S {
  const bound = storeForRequest(own, limits);
  return session === undefined ? bound : inSqliteSession(bound, session);
}

/** Detached work still writes through the stores, so it settles before they close; one past the
 * bound fails against the closed stores, and DetachedSet logs it. */
async function settleDetached(runtime: StoreRuntime, withinMs: number): Promise<void> {
  const left = await runtime.settle(withinMs);
  if (left === 0) return;
  const line = `shutdown: ${left} handed-off task(s) still running after ${withinMs} ms; closing the stores`;
  log.warn(line, { left });
}

/** hippo.db under `hippoRoot` as a server runs it: `opts.store` when given, else a worker store
 * on `opts`' executor. */
export function sqliteServerRuntime(
  hippoRoot: string,
  opts: ServerRuntimeOptions = {},
): SqliteServerRuntime {
  const { store: given, host = createHost(), ...executorOpts } = opts;
  // The server's own, even under `hippo serve`: the executor, the holder and the global stores
  // share its checkpoint state, and a CLI root's runtime ends with its command.
  const runtime = new StoreRuntime();
  const rules = { ...executorOpts, runtime };
  const store =
    given ?? workerSqliteStore(hippoRoot, createSqliteExecutor(hippoRoot, rules), rules);
  const globalStores = globalStoresFor(store, rules);
  const holder = createStoreHolder(hippoRoot, store, runtime);
  return {
    store,
    host,
    onHippoDb: isHippoDbStore(store),
    storeFor: boundToRequest,
    reachOf: (shared, limits, session) =>
      sqliteReach({
        hippoRoot,
        store,
        shared,
        openGlobal: (root) => boundToRequest(globalStores.open(root), limits, session),
        host,
      }),
    runRequest: (run) => runSqliteRequest(run, 'server', runtime),
    workerCounts,
    detached: runtime,
    hold: holder.hold,
    afterResponse: holder.afterResponse,
    close: async (settleWithinMs) => {
      await settleDetached(runtime, settleWithinMs);
      // The store's worker threads and the pooled handles close first, so the held one is still
      // SQLite's last.
      if (given === undefined) await store.close();
      await globalStores.close();
      runtime.closeNow();
      await holder.release();
    },
    closeOnExit: () => runtime.closeNow(),
  };
}
