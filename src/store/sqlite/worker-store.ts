// hippo.db as serve() runs it by default: the groups in the op table answer from worker threads, the rest still run on the calling thread.
import { outsideSqliteOffLoop } from '../../db.js';
import { currentRequestId } from '../../util/request-scope.js';
import type { HippoStore, Predictions, StoreGroups } from '../port.js';
import { createSqliteExecutor, type SqliteExecutor } from './executor.js';
import { sqliteStore } from './store.js';
import { type OpModes, type WorkerGroup, WORKER_OPS } from './worker-ops.js';

const offLoopStores = new WeakSet<HippoStore>();

/** Whether `store` answers its `loop: 'off'` routes from worker threads, so a hippo.db open on the server thread inside one is a defect. */
export function runsOffLoop(store: HippoStore): boolean {
  return offLoopStores.has(store);
}

/** Generated from the op table, so a new method of a group needs its tag and no body here. */
function workerGroup<G>(executor: SqliteExecutor, group: WorkerGroup, modes: OpModes<G>): G {
  const methods = Object.entries<OpModes<G>[keyof G]>(modes).map(([method, mode]) => [
    method,
    (...args: unknown[]) => executor.call(`${group}.${method}`, args, { mode, requestId: currentRequestId() }),
  ]);
  // SAFETY: `modes` names every method of G, and the worker answers each with the synchronous store's own result.
  return Object.fromEntries(methods) as G;
}

/** `sqliteStore` with the worker-backed groups in place of its in-process ones; close() closes `executor` and resolves once its threads have exited.
 *  `executor` defaults to threads of the store's own, with the server's lock wait. */
export function workerSqliteStore(hippoRoot: string, executor: SqliteExecutor = createSqliteExecutor(hippoRoot)): HippoStore & StoreGroups {
  const inProcess = sqliteStore(hippoRoot);
  const store: HippoStore & StoreGroups = {
    ...inProcess,
    // Key lookup still reads hippo.db on the server thread, so it leaves the block a `loop: 'off'` route's handler runs in.
    findApiKey: (keyId) => outsideSqliteOffLoop(() => inProcess.findApiKey(keyId)),
    predictions: workerGroup<Predictions>(executor, 'predictions', WORKER_OPS.predictions),
    close: () => executor.close(),
  };
  offLoopStores.add(store);
  return store;
}
