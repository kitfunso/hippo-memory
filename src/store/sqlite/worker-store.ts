// hippo.db as serve() runs it by default: the methods in the op table answer from worker threads, the rest still run on the calling thread.
import { currentDeadline, currentRequestId } from '../../util/request-scope.js';
import type { HippoStore, StoreGroups } from '../port.js';
import { createSqliteExecutor, type SqliteExecutor } from './executor.js';
import { sqliteStore } from './store.js';
import { type OpPlace, type OpPlaces, type WorkerBase, type WorkerGroup, WORKER_OPS } from './worker-ops.js';

const offLoopStores = new WeakSet<HippoStore>();

/** Whether `store` answers its `loop: 'off'` routes from worker threads, so a hippo.db open on the server thread inside one is a defect. */
export function runsOffLoop(store: HippoStore): boolean {
  return offLoopStores.has(store);
}

/** `inProcess` with each method the op table places on a worker answered from one, so a new method of a group needs its tag and no body here. */
function onWorkers<G>(executor: SqliteExecutor, group: WorkerGroup, places: OpPlaces<G>, inProcess: G): G {
  const moved = Object.entries<OpPlace>(places).flatMap(([method, place]) => (place === 'server' ? [] : [[
    method,
    (...args: unknown[]) => {
      const deadline = currentDeadline();
      const call = executor.call(`${group}.${method}`, args, { mode: place, requestId: currentRequestId(), deadlineAt: deadline?.at });
      // The request's own timer then waits for this call's answer, which names what became of a write.
      return deadline ? deadline.track(call) : call;
    },
  ]]));
  return { ...inProcess, ...Object.fromEntries(moved) };
}

/** `sqliteStore` with the worker-backed methods in place of its in-process ones; close() closes `executor` and resolves once its threads have exited.
 *  `executor` defaults to threads of the store's own, with the server's lock wait. */
export function workerSqliteStore(hippoRoot: string, executor: SqliteExecutor = createSqliteExecutor(hippoRoot)): HippoStore & StoreGroups {
  const inProcess = sqliteStore(hippoRoot);
  const { keyAudit, keyWrites, entryWrites, predictions, dagReads, auditLog } = WORKER_OPS;
  const store: HippoStore & StoreGroups = {
    ...inProcess,
    ...onWorkers<WorkerBase>(executor, 'base', WORKER_OPS.base, inProcess),
    keyAudit: onWorkers(executor, 'keyAudit', keyAudit, inProcess.keyAudit),
    keyWrites: onWorkers(executor, 'keyWrites', keyWrites, inProcess.keyWrites),
    entryWrites: onWorkers(executor, 'entryWrites', entryWrites, inProcess.entryWrites),
    predictions: onWorkers(executor, 'predictions', predictions, inProcess.predictions),
    dagReads: onWorkers(executor, 'dagReads', dagReads, inProcess.dagReads),
    auditLog: onWorkers(executor, 'auditLog', auditLog, inProcess.auditLog),
    close: () => executor.close(),
  };
  offLoopStores.add(store);
  return store;
}
