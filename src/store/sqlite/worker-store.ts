// hippo.db as serve() runs it by default: the methods in the op table answer from worker threads, the rest still run on the calling thread.
import { existsSync } from 'node:fs';
import { getHippoDbPath } from '../../db/index.js';
import { currentDeadline, currentRequestId } from '../../util/request-scope.js';
import type { HippoStore, Readiness, StoreGroups, VectorReads } from '../port.js';
import { createSqliteExecutor, type SqliteExecutor } from './executor.js';
import { sqliteStore } from './store.js';
import { vectorCopiesOf, type VectorPack, vectorViewsOf } from './vector-pack.js';
import { type OpMode, type OpPlace, type OpPlaces, type WorkerBase, type WorkerGroup, WORKER_OPS } from './worker-ops.js';

const offLoopStores = new WeakSet<HippoStore>();

/** Whether `store` answers its `loop: 'off'` routes from worker threads, so a hippo.db open on the server thread inside one is a defect. */
export function runsOffLoop(store: HippoStore): boolean {
  return offLoopStores.has(store);
}

function send<T>(executor: SqliteExecutor, op: string, args: readonly unknown[], mode: OpMode): Promise<T> {
  const deadline = currentDeadline();
  const call = executor.call<T>(op, args, { mode, requestId: currentRequestId(), deadlineAt: deadline?.at });
  // The request's own timer then waits for this call's answer, which names what became of a write.
  return deadline ? deadline.track(call) : call;
}

/** `inProcess` with each method the op table places on a worker answered from one, so a new method of a group needs its tag and no body here. */
function onWorkers<G>(executor: SqliteExecutor, group: WorkerGroup, places: OpPlaces<G>, inProcess: G): G {
  const moved = Object.entries<OpPlace>(places).flatMap(([method, place]) => (place === 'server' ? [] : [[
    method,
    (...args: unknown[]) => send(executor, `${group}.${method}`, args, place),
  ]]));
  return { ...inProcess, ...Object.fromEntries(moved) };
}

// The two reads that return vectors: the worker answers with one moved buffer, and the port's Map is rebuilt here. No ids reads nothing, as in process.
function vectorGroups(executor: SqliteExecutor, inProcess: VectorReads): Pick<StoreGroups, 'vectors' | 'vectorViews'> {
  const { vectors, vectorViews } = WORKER_OPS;
  const pack = (op: string, ids: readonly string[], mode: OpMode): Promise<VectorPack> => send(executor, op, [ids], mode);
  return {
    vectors: {
      ...onWorkers(executor, 'vectors', vectors, inProcess),
      storedVectors: async (ids) => (ids.length === 0 ? new Map() : vectorCopiesOf(await pack('vectors.storedVectors', ids, vectors.storedVectors))),
    },
    vectorViews: {
      storedVectorViews: async (ids) => (ids.length === 0 ? new Map() : vectorViewsOf(await pack('vectorViews.storedVectorViews', ids, vectorViews.storedVectorViews))),
    },
  };
}

// A probe must not create the store, and a worker's first job sets it up, so a root with no hippo.db is ready before any thread starts.
function probing(hippoRoot: string, served: Readiness): Readiness {
  return {
    ping: async () => {
      if (existsSync(getHippoDbPath(hippoRoot))) await served.ping();
    },
  };
}

/** `sqliteStore` with the worker-backed methods in place of its in-process ones; close() closes `executor` and resolves once its threads have exited.
 *  `executor` defaults to threads of the store's own, with the server's lock wait. */
export function workerSqliteStore(hippoRoot: string, executor: SqliteExecutor = createSqliteExecutor(hippoRoot)): HippoStore & StoreGroups {
  const inProcess = sqliteStore(hippoRoot);
  const { keyAudit, keyWrites, vectorWrites, entryWrites, contextReads, predictions, dagReads, auditLog, quarantine, graphReads, objects } = WORKER_OPS;
  const store: HippoStore & StoreGroups = {
    ...inProcess,
    ...onWorkers<WorkerBase>(executor, 'base', WORKER_OPS.base, inProcess),
    ...vectorGroups(executor, inProcess.vectors),
    keyAudit: onWorkers(executor, 'keyAudit', keyAudit, inProcess.keyAudit),
    keyWrites: onWorkers(executor, 'keyWrites', keyWrites, inProcess.keyWrites),
    vectorWrites: onWorkers(executor, 'vectorWrites', vectorWrites, inProcess.vectorWrites),
    entryWrites: onWorkers(executor, 'entryWrites', entryWrites, inProcess.entryWrites),
    contextReads: onWorkers(executor, 'contextReads', contextReads, inProcess.contextReads),
    predictions: onWorkers(executor, 'predictions', predictions, inProcess.predictions),
    dagReads: onWorkers(executor, 'dagReads', dagReads, inProcess.dagReads),
    auditLog: onWorkers(executor, 'auditLog', auditLog, inProcess.auditLog),
    quarantine: onWorkers(executor, 'quarantine', quarantine, inProcess.quarantine),
    graphReads: onWorkers(executor, 'graphReads', graphReads, inProcess.graphReads),
    objects: onWorkers(executor, 'objects', objects, inProcess.objects),
    readiness: probing(hippoRoot, onWorkers(executor, 'readiness', WORKER_OPS.readiness, inProcess.readiness)),
    close: () => executor.close(),
  };
  offLoopStores.add(store);
  return store;
}
