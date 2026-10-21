// hippo.db as serve() runs it by default: the methods in the op table answer from worker threads, the rest still run on
// the calling thread.
import { existsSync } from 'node:fs';
import { getHippoDbPath } from '../../db/index.js';
import { currentDeadline, currentRequestId, currentSignal } from '../../base/util/request-scope.js';
import type { HippoStore, Readiness, StoreGroups, VectorReads } from '../port.js';
import { createSqliteExecutor, type ExecutorOptions, type SqliteExecutor } from './executor.js';
import { sqliteStore } from './store.js';
import type { LossAversion } from '../../base/memory/memory.js';
import { vectorCopiesOf, type VectorPack, vectorViewsOf } from './vector-pack.js';
import { type OpPlaces, type OpRoute, type WorkerBase, type WorkerGroup, WORKER_OPS } from './worker-ops.js';
import { asHippoDb } from './hippo-db-stores.js';

const offLoopStores = new WeakSet<HippoStore>();

/** Whether `store` answers its `loop: 'off'` routes from worker threads, so a hippo.db open on the server thread inside
 * one is a defect. */
export function runsOffLoop(store: HippoStore): boolean {
  return offLoopStores.has(store);
}

function send<T>(executor: SqliteExecutor, op: string, args: readonly unknown[], mode: OpRoute): Promise<T> {
  const deadline = currentDeadline();
  const call = executor.call<T>(op, args, {
    mode,
    requestId: currentRequestId(),
    deadlineAt: deadline?.at,
    signal: currentSignal(),
  });
  // The request's own timer then waits for this call's answer, which names what became of a write.
  return deadline ? deadline.track(call) : call;
}

/** `inProcess` with each method the op table places on a worker answered from one, so a new method of a group needs its
 * tag and no body here. */
function onWorkers<G>(executor: SqliteExecutor, group: WorkerGroup, places: OpPlaces<G>, inProcess: G): G {
  const moved = Object.entries<OpRoute>(places).map(([method, place]) => [
    method,
    (...args: unknown[]) => send(executor, `${group}.${method}`, args, place),
  ]);
  return { ...inProcess, ...Object.fromEntries(moved) };
}

// The two reads that return vectors: the worker answers with one moved buffer, and the port's Map is rebuilt here. No
// ids reads nothing, as in process.
function vectorGroups(executor: SqliteExecutor, inProcess: VectorReads): Pick<StoreGroups, 'vectors' | 'vectorViews'> {
  const { vectors, vectorViews } = WORKER_OPS;
  const pack = (op: string, ids: readonly string[], mode: OpRoute): Promise<VectorPack> =>
    send(executor, op, [ids], mode);
  return {
    vectors: {
      ...onWorkers(executor, 'vectors', vectors, inProcess),
      storedVectors: async (ids) =>
        ids.length === 0 ? new Map() : vectorCopiesOf(await pack('vectors.storedVectors', ids, vectors.storedVectors)),
    },
    vectorViews: {
      storedVectorViews: async (ids) =>
        ids.length === 0
          ? new Map()
          : vectorViewsOf(await pack('vectorViews.storedVectorViews', ids, vectorViews.storedVectorViews)),
    },
  };
}

// A probe must not create the store, and a worker's first job sets it up, so a root with no hippo.db is ready before
// any thread starts.
function probing(hippoRoot: string, served: Readiness): Readiness {
  return {
    ping: async () => {
      if (existsSync(getHippoDbPath(hippoRoot))) await served.ping();
    },
  };
}

type RecallAndWriteGroups = Pick<
  StoreGroups,
  | 'keyAudit'
  | 'keyWrites'
  | 'keyGrants'
  | 'vectorWrites'
  | 'entryWrites'
  | 'contextReads'
  | 'predictions'
  | 'dagReads'
  | 'auditLog'
  | 'quarantine'
  | 'graphReads'
  | 'objects'
  | 'lastRecall'
  | 'connectorWrites'
  | 'connectorEvents'
>;

function recallAndWriteGroups(executor: SqliteExecutor, inProcess: StoreGroups): RecallAndWriteGroups {
  const ops = WORKER_OPS;
  return {
    keyAudit: onWorkers(executor, 'keyAudit', ops.keyAudit, inProcess.keyAudit),
    keyWrites: onWorkers(executor, 'keyWrites', ops.keyWrites, inProcess.keyWrites),
    keyGrants: onWorkers(executor, 'keyGrants', ops.keyGrants, inProcess.keyGrants),
    vectorWrites: onWorkers(executor, 'vectorWrites', ops.vectorWrites, inProcess.vectorWrites),
    entryWrites: onWorkers(executor, 'entryWrites', ops.entryWrites, inProcess.entryWrites),
    contextReads: onWorkers(executor, 'contextReads', ops.contextReads, inProcess.contextReads),
    predictions: onWorkers(executor, 'predictions', ops.predictions, inProcess.predictions),
    dagReads: onWorkers(executor, 'dagReads', ops.dagReads, inProcess.dagReads),
    auditLog: onWorkers(executor, 'auditLog', ops.auditLog, inProcess.auditLog),
    quarantine: onWorkers(executor, 'quarantine', ops.quarantine, inProcess.quarantine),
    graphReads: onWorkers(executor, 'graphReads', ops.graphReads, inProcess.graphReads),
    objects: onWorkers(executor, 'objects', ops.objects, inProcess.objects),
    lastRecall: onWorkers(executor, 'lastRecall', ops.lastRecall, inProcess.lastRecall),
    connectorWrites: onWorkers(executor, 'connectorWrites', ops.connectorWrites, inProcess.connectorWrites),
    connectorEvents: onWorkers(executor, 'connectorEvents', ops.connectorEvents, inProcess.connectorEvents),
  };
}

type SessionAndAdminGroups = Pick<
  StoreGroups,
  | 'auditMaintenance'
  | 'lessonWrites'
  | 'sessions'
  | 'cards'
  | 'goals'
  | 'conflicts'
  | 'dormant'
  | 'reports'
  | 'rejections'
  | 'failureLog'
  | 'compactions'
>;

function sessionAndAdminGroups(executor: SqliteExecutor, inProcess: StoreGroups): SessionAndAdminGroups {
  const ops = WORKER_OPS;
  return {
    auditMaintenance: onWorkers(executor, 'auditMaintenance', ops.auditMaintenance, inProcess.auditMaintenance),
    lessonWrites: onWorkers(executor, 'lessonWrites', ops.lessonWrites, inProcess.lessonWrites),
    sessions: onWorkers(executor, 'sessions', ops.sessions, inProcess.sessions),
    cards: onWorkers(executor, 'cards', ops.cards, inProcess.cards),
    goals: onWorkers(executor, 'goals', ops.goals, inProcess.goals),
    conflicts: onWorkers(executor, 'conflicts', ops.conflicts, inProcess.conflicts),
    dormant: onWorkers(executor, 'dormant', ops.dormant, inProcess.dormant),
    reports: onWorkers(executor, 'reports', ops.reports, inProcess.reports),
    rejections: onWorkers(executor, 'rejections', ops.rejections, inProcess.rejections),
    failureLog: onWorkers(executor, 'failureLog', ops.failureLog, inProcess.failureLog),
    compactions: onWorkers(executor, 'compactions', ops.compactions, inProcess.compactions),
  };
}

type FolderGroups = Pick<StoreGroups, 'ledger' | 'embeddingIndex' | 'promotion' | 'folderFiles' | 'sharing'>;

function folderGroups(executor: SqliteExecutor, inProcess: StoreGroups): FolderGroups {
  const ops = WORKER_OPS;
  return {
    ledger: onWorkers(executor, 'ledger', ops.ledger, inProcess.ledger),
    embeddingIndex: onWorkers(executor, 'embeddingIndex', ops.embeddingIndex, inProcess.embeddingIndex),
    promotion: onWorkers(executor, 'promotion', ops.promotion, inProcess.promotion),
    folderFiles: onWorkers(executor, 'folderFiles', ops.folderFiles, inProcess.folderFiles),
    sharing: onWorkers(executor, 'sharing', ops.sharing, inProcess.sharing),
  };
}

type LocalGroups = Pick<
  StoreGroups,
  | 'consolidation'
  | 'learning'
  | 'captures'
  | 'compactionHooks'
  | 'projectTags'
  | 'diagnostics'
  | 'graphRebuild'
  | 'agentImport'
>;

function localGroups(executor: SqliteExecutor, inProcess: StoreGroups): LocalGroups {
  const ops = WORKER_OPS;
  return {
    consolidation: onWorkers(executor, 'consolidation', ops.consolidation, inProcess.consolidation),
    learning: onWorkers(executor, 'learning', ops.learning, inProcess.learning),
    captures: onWorkers(executor, 'captures', ops.captures, inProcess.captures),
    compactionHooks: onWorkers(executor, 'compactionHooks', ops.compactionHooks, inProcess.compactionHooks),
    projectTags: onWorkers(executor, 'projectTags', ops.projectTags, inProcess.projectTags),
    diagnostics: onWorkers(executor, 'diagnostics', ops.diagnostics, inProcess.diagnostics),
    graphRebuild: onWorkers(executor, 'graphRebuild', ops.graphRebuild, inProcess.graphRebuild),
    agentImport: onWorkers(executor, 'agentImport', ops.agentImport, inProcess.agentImport),
  };
}

/** `sqliteStore` with every method the op table places on a worker answered from one; close() closes `executor` and
 * resolves once its threads have exited. `executor` defaults to threads of the store's own, with the server's lock
 * wait; `rules` must be the ones it was built with. */
export function workerSqliteStore(
  hippoRoot: string,
  executor: SqliteExecutor = createSqliteExecutor(hippoRoot),
  rules: LossAversion = {},
): HippoStore & StoreGroups {
  const inProcess = sqliteStore(hippoRoot, rules);
  const store: HippoStore & StoreGroups = {
    ...inProcess,
    ...onWorkers<WorkerBase>(executor, 'base', WORKER_OPS.base, inProcess),
    ...vectorGroups(executor, inProcess.vectors),
    ...recallAndWriteGroups(executor, inProcess),
    ...sessionAndAdminGroups(executor, inProcess),
    ...folderGroups(executor, inProcess),
    ...localGroups(executor, inProcess),
    readiness: probing(hippoRoot, onWorkers(executor, 'readiness', WORKER_OPS.readiness, inProcess.readiness)),
    close: () => executor.close(),
  };
  offLoopStores.add(store);
  return asHippoDb(store);
}

/** The operator's global stores a server opens beside its own, closed with it. */
interface GlobalStores {
  readonly open: (root: string) => HippoStore & StoreGroups;
  readonly close: () => Promise<void>;
}

/** On threads of their own when `served` answers from workers, so a `loop: 'off'` route never opens one on the server
 * thread; each is built at first use, since the global store can appear while the server runs. */
export function globalStoresFor(served: HippoStore, executorOpts: ExecutorOptions = {}): GlobalStores {
  if (!runsOffLoop(served)) return { open: (root) => sqliteStore(root, executorOpts), close: async () => {} };
  const opened = new Map<string, HippoStore & StoreGroups>();
  return {
    open(root) {
      const known = opened.get(root);
      if (known !== undefined) return known;
      const made = workerSqliteStore(root, createSqliteExecutor(root, executorOpts), executorOpts);
      opened.set(root, made);
      return made;
    },
    async close() {
      const closing = [...opened.values()];
      opened.clear();
      await Promise.all(closing.map((store) => store.close()));
    },
  };
}
