// hippo.db as serve() runs it by default: the methods in the op table answer from worker threads, the rest still run on
// the calling thread.
import { existsSync } from 'node:fs';
import { getHippoDbPath } from '../../../db/index.js';
import { currentDeadline, currentRequestId, currentSignal } from '../../../base/util/request-scope.js';
import type {
  HippoStore,
  Readiness,
  StoreGroups,
  StoredPart,
  StoredParts,
  VectorReads,
} from '../../../base/ports/store.js';
import { createSqliteExecutor, type ExecutorOptions, type SqliteExecutor } from './executor.js';
import { sqliteStore } from '../store.js';
import type { StoreRules } from '../../../base/ports/infra.js';
import { type VectorPack, vectorViewsOf } from './vector-pack.js';
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

type SentParts = { readonly [P in StoredPart]: (ids: readonly string[]) => Promise<Map<string, StoredParts[P]>> };

// Stored vectors come back as one moved buffer, and the port's Map of views is rebuilt here. No ids reads nothing,
// as in process.
function vectorGroups(executor: SqliteExecutor, inProcess: VectorReads): Pick<StoreGroups, 'vectors'> {
  const { vectors } = WORKER_OPS;
  const sent: SentParts = {
    vectors: async (ids) =>
      vectorViewsOf(await send<VectorPack>(executor, 'vectors.stored', ['vectors', ids], vectors.stored)),
    particles: (ids) => send(executor, 'vectors.stored', ['particles', ids], vectors.stored),
  };
  return {
    vectors: {
      ...onWorkers(executor, 'vectors', vectors, inProcess),
      stored: async (part, ids) => (ids.length === 0 ? new Map() : sent[part](ids)),
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

/** The groups with a body of their own below: base sits on the store itself, vectors rebuild a Map, readiness is
 * probed. */
type CustomGroup = 'base' | 'vectors' | 'readiness';
type PlainGroup = Exclude<WorkerGroup, CustomGroup>;

const isPlainGroup = (group: WorkerGroup): group is PlainGroup =>
  group !== 'base' && group !== 'vectors' && group !== 'readiness';

// SAFETY: Object.keys of the WORKER_OPS literal lists exactly its WorkerGroup keys.
const PLAIN_GROUPS = (Object.keys(WORKER_OPS) as WorkerGroup[]).filter(isPlainGroup);

/** Every other group, wrapped the same way; the op table's `satisfies` check makes a group it misses a compile
 * error. */
function plainGroups(executor: SqliteExecutor, inProcess: StoreGroups): Pick<StoreGroups, PlainGroup> {
  const wrapped = PLAIN_GROUPS.map((group) => [group, onWorkers(executor, group, WORKER_OPS[group], inProcess[group])]);
  // SAFETY: each entry pairs a group name with that group's own wrapped methods, so the object has every PlainGroup
  // key.
  return Object.fromEntries(wrapped) as Pick<StoreGroups, PlainGroup>;
}

/** `sqliteStore` with every method the op table places on a worker answered from one; close() closes `executor` and
 * resolves once its threads have exited. `executor` defaults to threads of the store's own, with the server's lock
 * wait; `rules` must be the ones it was built with. */
export function workerSqliteStore(
  hippoRoot: string,
  executor: SqliteExecutor = createSqliteExecutor(hippoRoot),
  rules: StoreRules = {},
): HippoStore & StoreGroups {
  const inProcess = sqliteStore(hippoRoot, rules);
  const store: HippoStore & StoreGroups = {
    ...inProcess,
    ...onWorkers<WorkerBase>(executor, 'base', WORKER_OPS.base, inProcess),
    ...vectorGroups(executor, inProcess.vectors),
    ...plainGroups(executor, inProcess),
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
