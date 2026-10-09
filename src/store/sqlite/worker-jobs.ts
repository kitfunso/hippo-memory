// A store worker's side of the executor: one job at a time, on one connection the thread holds for its life.
import type { MessagePort } from 'node:worker_threads';
import { auditWriteFailureCount } from '../audit.js';
import { type DatabaseSyncLike, RequestStores } from '../../db/index.js';
import type { OpenedDb } from '../../db/connect.js';
import { loadStoredVectorViews } from '../vector-index.js';
import { requestScopes } from '../../util/request-scope.js';
import { initStore } from '../open.js';
import { watchCommits } from './commit-watch.js';
import { encodeError } from './error-codec.js';
import { sqliteSyncStore } from './store.js';
import { PackedVectors, packVectors } from './vector-pack.js';
import { sqliteVectorReads } from './vector-reads-group.js';
import { type Job, type OpPlace, type Reply, STORE_SETUP_OP, type WorkerGroup, type WorkerInit, WORKER_OPS } from './worker-ops.js';

/** Every method the op table can name: the synchronous store, and the vector reads, which answer only through Promises.
 *  The two reads that return vectors answer with a pack, which worker-store.ts turns back into the port's Map. */
function workerOps(hippoRoot: string) {
  const packed = (ids: readonly string[]) => packVectors(loadStoredVectorViews(hippoRoot, ids));
  return {
    ...sqliteSyncStore(hippoRoot),
    vectors: { ...sqliteVectorReads(hippoRoot), storedVectors: packed },
    vectorViews: { storedVectorViews: packed },
  };
}

type Ops = ReturnType<typeof workerOps>;

/** The scope every job of a thread runs in, so each open inside a job gets the thread's one connection. */
class WorkerStores extends RequestStores {
  override requestId: string | undefined = undefined;
  walPages: number | undefined;
  jobId = 0;
  readonly #init: WorkerInit;
  readonly #commitFlag: Int32Array | undefined;
  readonly #prepared = new WeakSet<DatabaseSyncLike>();
  readonly #walPagesOn = new WeakMap<DatabaseSyncLike, number>();

  constructor(init: WorkerInit) {
    // The executor sends a reader its first job only after the writer has run the setup.
    super({ busyWaitMs: init.busyWaitMs, ...(init.mode === 'read' && { setupDoneFor: init.hippoRoot }) });
    this.#init = init;
    this.#commitFlag = init.commitFlag && new Int32Array(init.commitFlag);
  }

  // The one path every open of the scope takes: `get` is a wrapper over it.
  override getWithFacts(hippoRoot: string, opts?: { busyWaitMs?: number }): OpenedDb {
    const opened = super.getWithFacts(hippoRoot, opts);
    const { db } = opened;
    if (!this.#prepared.has(db)) {
      this.#prepared.add(db);
      // A reader that could write would let a method wrongly tagged 'read' take the write lock off the writer thread.
      if (this.#init.mode === 'read') db.exec('PRAGMA query_only = ON');
      const flag = this.#commitFlag;
      if (flag) watchCommits(db, () => Atomics.store(flag, 0, this.jobId));
    }
    // The connection set its own value from this thread's state, where no checkpointer ever runs.
    if (hippoRoot === this.#init.hippoRoot && this.walPages !== undefined && this.#walPagesOn.get(db) !== this.walPages) {
      db.exec(`PRAGMA wal_autocheckpoint = ${this.walPages}`);
      this.#walPagesOn.set(db, this.walPages);
    }
    return opened;
  }
}

function isWorkerGroup(group: string): group is WorkerGroup {
  return Object.hasOwn(WORKER_OPS, group);
}

function runsOnWorker(group: WorkerGroup, method: string): boolean {
  const places: Readonly<Record<string, OpPlace>> = WORKER_OPS[group];
  return Object.hasOwn(places, method) && places[method] !== 'server';
}

type MethodsOf<T> = T extends T ? T[keyof T] : never;

/** What a method the op table names can return. */
type Ran = ReturnType<MethodsOf<Ops[Exclude<WorkerGroup, 'base'>] | Pick<Ops, keyof typeof WORKER_OPS.base>>>;

function methodsOf(ops: Ops, group: WorkerGroup) {
  // SAFETY: every group is an object of methods, and the server thread sent the arguments the port's own signature for the one called took.
  return (group === 'base' ? ops : ops[group]) as Readonly<Record<string, ((...sent: readonly unknown[]) => Ran) | undefined>>;
}

/** Runs `op`; only a method the op table places on a worker can run. */
function runOp(ops: Ops, op: string, args: readonly unknown[]) {
  const [group = '', method = ''] = op.split('.');
  const run = isWorkerGroup(group) && runsOnWorker(group, method) ? methodsOf(ops, group)[method] : undefined;
  if (run === undefined) throw new Error(`the store worker has no op '${op}'`);
  return run(...args);
}

async function answer(ops: Ops, stores: WorkerStores, hippoRoot: string, job: Job): Promise<Reply> {
  const failuresBefore = auditWriteFailureCount();
  stores.requestId = job.requestId;
  stores.walPages = job.walPages;
  stores.jobId = job.id;
  try {
    const value = await requestScopes.run(stores, () => (job.op === STORE_SETUP_OP ? initStore(hippoRoot) : runOp(ops, job.op, job.args)));
    return { id: job.id, ok: true, value, auditFailures: auditWriteFailureCount() - failuresBefore };
  } catch (err) {
    return { id: job.id, ok: false, error: encodeError(err), auditFailures: auditWriteFailureCount() - failuresBefore };
  }
}

function post(port: MessagePort, reply: Reply): void {
  try {
    port.postMessage(reply, reply.ok && reply.value instanceof PackedVectors ? [reply.value.buffer] : []);
  } catch (err) {
    // A result that cannot be copied to the server thread must still answer, or its caller would wait for ever.
    port.postMessage({ id: reply.id, ok: false, error: encodeError(err), auditFailures: reply.auditFailures } satisfies Reply);
  }
}

/** Answers the thread's jobs until 'stop', which closes the connection so the thread ends with no handle on the store's files. */
export function serveJobs(port: MessagePort, init: WorkerInit): void {
  const ops = workerOps(init.hippoRoot);
  const stores = new WorkerStores(init);
  // A thread is sent one job at a time, so only 'stop' can arrive while a vector scan yields, and it waits for that job's reply.
  let last: Promise<void> = Promise.resolve();
  port.on('message', (message: Job | 'stop') => {
    if (message === 'stop') {
      void last.then(() => {
        stores.close();
        port.close();
      });
      return;
    }
    last = answer(ops, stores, init.hippoRoot, message).then((reply) => post(port, reply));
  });
}
