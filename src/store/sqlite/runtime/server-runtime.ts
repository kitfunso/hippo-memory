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
  readonly store?: HippoStore | undefined;
  readonly host?: Host | undefined;
}

/** The served store and what a listener calls around each response; close() ends it all, the
 * held connection last. */
export interface SqliteServerRuntime extends Omit<StoreHolder, 'release'> {
  readonly store: HippoStore;
  readonly host: Host;
  readonly onHippoDb: boolean;
  readonly storeFor: <S extends HippoStore>(
    store: S,
    limits: RequestLimits,
    session?: RequestStores,
  ) => S;
  readonly reachOf: (shared: boolean, limits: RequestLimits, session?: RequestStores) => StoreReach;
  readonly runRequest: <T>(run: (session: RequestStores) => Promise<T>) => Promise<T>;
  readonly workerCounts: Readonly<typeof workerCounts>;
  readonly detached: Pick<StoreRuntime, 'detach'>;
  readonly close: (settleWithinMs: number) => Promise<void>;
  readonly closeOnExit: () => void;
}

function boundToRequest<S extends HippoStore>(
  own: S,
  limits: RequestLimits,
  session?: RequestStores,
): S {
  const bound = storeForRequest(own, limits);
  return session === undefined ? bound : inSqliteSession(bound, session);
}

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
      if (given === undefined) await store.close();
      await globalStores.close();
      runtime.closeNow();
      await holder.release();
    },
    closeOnExit: () => runtime.closeNow(),
  };
}
