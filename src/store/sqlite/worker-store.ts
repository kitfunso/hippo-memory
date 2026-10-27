// hippo.db as serve() runs it by default: every method in the op table answers from a worker
// thread, and the server thread's own part of the store refuses to open hippo.db.
import { existsSync } from 'node:fs';
import { getHippoDbPath, SERVER_DB_WAIT_MS } from '../../db/index.js';
import { currentRequestId, type RequestLimits } from '../../base/util/request-scope.js';
import type {
  HippoStore,
  Readiness,
  StoreGroups,
  StoredPart,
  StoredParts,
  VectorReads,
} from '../../base/ports/store.js';
import { createSqliteExecutor, type ExecutorOptions, type SqliteExecutor } from './executor.js';
import { sqliteStore, sqliteStoreOn } from './store.js';
import type { StoreRules } from '../../base/ports/infra.js';
import type { StoreRuntime } from '../../db/store-runtime.js';
import { type VectorPack, vectorViewsOf } from './vector-pack.js';
import {
  type OpPlaces,
  type OpRoute,
  type WorkerBase,
  type WorkerGroup,
  WORKER_OPS,
} from './worker-ops.js';
import { asHippoDb } from './hippo-db-stores.js';
import { handlesOf } from './handles.js';

/** The worker a call goes to and the request it answers. */
interface Sender {
  readonly executor: SqliteExecutor;
  readonly limits: RequestLimits;
}

// Non-enumerable marks on their owners: a worker store, and each method that answers from a worker
// with how to make it again for another request's limits.
const OFF_LOOP = Symbol('answers from workers');
const REBIND = Symbol('worker call rebind');

interface Rebindable {
  readonly [REBIND]: (limits: RequestLimits) => Function;
}

function isRebindable<V>(value: V): value is V & Function & Rebindable {
  return value instanceof Function && REBIND in value;
}

function markOffLoop<S extends HippoStore>(store: S): S {
  Object.defineProperty(store, OFF_LOOP, { value: true });
  return store;
}

/** Whether `store` answers its methods from worker threads. */
export function runsOffLoop(store: HippoStore): boolean {
  return OFF_LOOP in store;
}

function send<T>(
  { executor, limits }: Sender,
  op: string,
  args: readonly unknown[],
  mode: OpRoute,
): Promise<T> {
  const { deadline, signal } = limits;
  const call = executor.call<T>(op, args, {
    mode,
    requestId: currentRequestId(),
    deadlineAt: deadline?.at,
    signal,
  });
  // The request's own timer then waits for this call's answer, which names what became of a write.
  return deadline ? deadline.track(call) : call;
}

function workerCall(sender: Sender, op: string, mode: OpRoute): Function {
  const call = (...args: unknown[]) => send(sender, op, args, mode);
  const rebind: Rebindable[typeof REBIND] = (limits) => workerCall({ ...sender, limits }, op, mode);
  Object.defineProperty(call, REBIND, { value: rebind });
  return call;
}

/** `inProcess` with each method the op table places on a worker answered from one, so a new
 * method of a group needs its tag and no body here. */
function onWorkers<G>(sender: Sender, group: WorkerGroup, places: OpPlaces<G>, inProcess: G): G {
  const moved = Object.entries<OpRoute>(places).map(([method, place]) => [
    method,
    workerCall(sender, `${group}.${method}`, place),
  ]);
  return { ...inProcess, ...Object.fromEntries(moved) };
}

type SentParts = {
  readonly [P in StoredPart]: (ids: readonly string[]) => Promise<Map<string, StoredParts[P]>>;
};

// Stored vectors come back as one moved buffer, and the port's Map of views is rebuilt here. No ids
// reads nothing, as in process.
function storedOnWorkers(sender: Sender): VectorReads['stored'] {
  const mode = WORKER_OPS.vectors.stored;
  const sent: SentParts = {
    vectors: async (ids) =>
      vectorViewsOf(await send<VectorPack>(sender, 'vectors.stored', ['vectors', ids], mode)),
    particles: (ids) => send(sender, 'vectors.stored', ['particles', ids], mode),
  };
  const stored: VectorReads['stored'] = async (part, ids) =>
    ids.length === 0 ? new Map() : sent[part](ids);
  const rebind: Rebindable[typeof REBIND] = (limits) => storedOnWorkers({ ...sender, limits });
  Object.defineProperty(stored, REBIND, { value: rebind });
  return stored;
}

function vectorGroups(sender: Sender, inProcess: VectorReads): Pick<StoreGroups, 'vectors'> {
  return {
    vectors: {
      ...onWorkers(sender, 'vectors', WORKER_OPS.vectors, inProcess),
      stored: storedOnWorkers(sender),
    },
  };
}

// A probe must not create the store, and a worker's first job sets it up, so a root with no
// hippo.db is ready before any thread starts.
function probing(hippoRoot: string, served: Readiness): Readiness {
  return {
    ping: async () => {
      if (existsSync(getHippoDbPath(hippoRoot))) await served.ping();
    },
  };
}

/** The groups with a body of their own below: base sits on the store itself, vectors rebuild a
 * Map, readiness is probed. */
type CustomGroup = 'base' | 'vectors' | 'readiness';
type PlainGroup = Exclude<WorkerGroup, CustomGroup>;

const isPlainGroup = (group: WorkerGroup): group is PlainGroup =>
  group !== 'base' && group !== 'vectors' && group !== 'readiness';

// SAFETY: Object.keys of the WORKER_OPS literal lists exactly its WorkerGroup keys.
const PLAIN_GROUPS = (Object.keys(WORKER_OPS) as WorkerGroup[]).filter(isPlainGroup);

/** Every other group, wrapped the same way; the op table's `satisfies` check makes a group it
 * misses a compile error. */
function plainGroups(sender: Sender, inProcess: StoreGroups): Pick<StoreGroups, PlainGroup> {
  const wrapped = PLAIN_GROUPS.map((group) => [
    group,
    onWorkers(sender, group, WORKER_OPS[group], inProcess[group]),
  ]);
  // SAFETY: each entry pairs a group name with that group's own wrapped methods, so the object has
  // every PlainGroup key.
  return Object.fromEntries(wrapped) as Pick<StoreGroups, PlainGroup>;
}

/** The rules a worker store's threads open with, and the server's runtime its checkpoints run
 * under. */
export interface WorkerStoreOptions extends StoreRules {
  readonly runtime?: StoreRuntime | undefined;
}

/** `sqliteStore` with every method the op table places on a worker answered from one; close()
 * closes `executor` and resolves once its threads have exited. `executor` defaults to threads of
 * the store's own, with the server's lock wait; `opts` must hold the rules it was built with. */
export function workerSqliteStore(
  hippoRoot: string,
  executor: SqliteExecutor = createSqliteExecutor(hippoRoot),
  { runtime, ...rules }: WorkerStoreOptions = {},
): HippoStore & StoreGroups {
  // A method the op table missed would run here, on the server thread, where every open of this
  // part refuses.
  const inProcess = sqliteStoreOn(handlesOf(hippoRoot, { ...rules, runtime, workerOnly: true }));
  const sender: Sender = { executor, limits: {} };
  const store: HippoStore & StoreGroups = {
    ...inProcess,
    ...onWorkers<WorkerBase>(sender, 'base', WORKER_OPS.base, inProcess),
    ...vectorGroups(sender, inProcess.vectors),
    ...plainGroups(sender, inProcess),
    readiness: probing(
      hippoRoot,
      onWorkers(sender, 'readiness', WORKER_OPS.readiness, inProcess.readiness),
    ),
    close: () => executor.close(),
  };
  return asHippoDb(markOffLoop(store));
}

function rebound<V>(value: V, limits: RequestLimits): V {
  // SAFETY: a rebind makes the same worker call again, so the new function has the old one's
  // signature.
  return isRebindable(value) ? (value[REBIND](limits) as V) : value;
}

function isPlainObject<V>(value: V): value is V & object {
  return value instanceof Object && Object.getPrototypeOf(value) === Object.prototype;
}

/** `store` with each worker call, its groups' too, bound to one request's `limits`; any other
 * member stays as it is, so a store a caller patched keeps its patches. */
export function storeForRequest<S extends HippoStore>(store: S, limits: RequestLimits): S {
  if (!runsOffLoop(store)) return store;
  const bound: Partial<S> = { ...store };
  // SAFETY: Object.keys lists the store's own string keys, which are keys of S.
  for (const key of Object.keys(store) as (keyof S)[]) {
    const value = store[key];
    const group = isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).map(([k, m]) => [k, rebound(m, limits)]))
      : undefined;
    // SAFETY: a group keeps its keys, each method rebound to the same signature.
    bound[key] = (group ?? rebound(value, limits)) as S[keyof S];
  }
  // SAFETY: every own key of `store` was copied above, and its symbols with the spread.
  return markOffLoop(bound as S);
}

/** The operator's global stores a server opens beside its own, closed with it. */
interface GlobalStores {
  readonly open: (root: string) => HippoStore & StoreGroups;
  readonly close: () => Promise<void>;
}

/** On threads of their own when `served` answers from workers; each is built at first use, since
 * the global store can appear while the server runs. Beside any other store, a global one opens
 * on the server thread at the server's wait. */
export function globalStoresFor(
  served: HippoStore,
  executorOpts: ExecutorOptions = {},
): GlobalStores {
  const { runtime, strength, lossAversionRatio, fakeNowMs } = executorOpts;
  const rules = { runtime, strength, lossAversionRatio, fakeNowMs };
  if (!runsOffLoop(served)) {
    return {
      open: (root) => sqliteStore(root, { ...rules, busyWaitMs: SERVER_DB_WAIT_MS }),
      close: async () => {},
    };
  }
  const opened = new Map<string, HippoStore & StoreGroups>();
  return {
    open(root) {
      const known = opened.get(root);
      if (known !== undefined) return known;
      const made = workerSqliteStore(root, createSqliteExecutor(root, executorOpts), rules);
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
