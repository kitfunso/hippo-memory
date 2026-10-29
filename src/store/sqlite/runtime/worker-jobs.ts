// A store worker's side of the executor: one job at a time, on one connection the thread holds for
// its life.
import type { MessagePort } from 'node:worker_threads';
import { auditWriteFailureCount } from '../../../base/records/audit-report.js';
import { type DatabaseSyncLike, RequestStores } from '../../../db/index.js';
import { SESSION_OPEN } from '../../../db/request-stores.js';
import type { OpenedDb } from '../../../db/connect.js';
import { VectorGraphs } from '../../../db/vector-graph-index.js';
import { errorFields, log } from '../../../base/util/log.js';
import { postReply } from '../../../base/util/thread-reply.js';
import { runWithRequestId } from '../../../base/util/request-scope.js';
import { handlesOf, initStore } from './handles.js';
import { watchCommits } from './commit-watch.js';
import { StoreRuntime } from '../../../db/store-runtime.js';
import { grantFor } from './grant.js';
import { encodeError } from './error-codec.js';
import { sqliteStoreOn } from '../store.js';
import { restoreAllTenants } from './tenant-wire.js';
import { PackedVectors, packVectors } from './vector-pack.js';
import { sqliteVectorReads } from '../vectors/vector-reads.js';
import type { StoredPart } from '../../../base/ports/store.js';
import {
  HIPPO_DB_OPS,
  type HippoDbRepo,
  type Job,
  type OpRoute,
  type Reply,
  STORE_SETUP_OP,
  type WorkerGroup,
  type WorkerInit,
  WORKER_OPS,
} from './worker-ops.js';

/** Every method the op table can name, on the thread's store, each run to its end on the
 * thread's one connection; stored vectors answer as a pack, which worker-store.ts turns back
 * into the port's Map. */
function workerOps(
  { hippoRoot, rules }: WorkerInit,
  graphs: VectorGraphs | undefined,
  session: WorkerStores,
) {
  const handles = handlesOf(hippoRoot, { ...rules, session });
  const store = sqliteStoreOn(handles);
  const vectors = sqliteVectorReads(handles, graphs);
  const stored = async (part: StoredPart, ids: readonly string[]) =>
    packVectors(await vectors.stored(part, ids));
  return { ...store, vectors: { ...vectors, stored } };
}

type Ops = ReturnType<typeof workerOps>;

/** The session every job of a thread opens through, so each open inside a job gets the thread's
 * one connection. */
class WorkerStores extends RequestStores {
  walPages: number | undefined;
  jobId = 0;
  readonly #init: WorkerInit;
  readonly #commitFlag: Int32Array | undefined;
  readonly #prepared = new WeakSet<DatabaseSyncLike>();
  readonly #walPagesOn = new WeakMap<DatabaseSyncLike, number>();

  constructor(init: WorkerInit, runtime: StoreRuntime) {
    // The executor sends a reader its first job only after the writer has run the setup.
    super({
      runtime,
      busyWaitMs: init.busyWaitMs,
      ...(init.mode === 'read' && { setupDoneFor: init.hippoRoot }),
    });
    this.#init = init;
    this.#commitFlag = init.commitFlag && new Int32Array(init.commitFlag);
  }

  // The one path every open of the scope takes.
  override [SESSION_OPEN](hippoRoot: string, opts?: { busyWaitMs?: number }): OpenedDb {
    const opened = super[SESSION_OPEN](hippoRoot, opts);
    const { db } = opened;
    if (!this.#prepared.has(db)) {
      this.#prepared.add(db);
      // A reader that could write would let a method wrongly tagged 'read' take the write lock off
      // the writer thread.
      if (this.#init.mode === 'read') db.exec('PRAGMA query_only = ON');
      const flag = this.#commitFlag;
      if (flag) watchCommits(db, () => Atomics.store(flag, 0, this.jobId));
    }
    // The connection set its own value from this thread's state, where no checkpointer ever runs.
    if (
      hippoRoot === this.#init.hippoRoot &&
      this.walPages !== undefined &&
      this.#walPagesOn.get(db) !== this.walPages
    ) {
      db.exec(`PRAGMA wal_autocheckpoint = ${this.walPages}`);
      this.#walPagesOn.set(db, this.walPages);
    }
    return opened;
  }
}

/** Whether `table` places `method` under `group`, so a name off the op table runs nothing. */
function placed<T extends Readonly<Record<string, Readonly<Record<string, OpRoute>>>>>(
  table: T,
  group: string,
  method: string,
): group is keyof T & string {
  return Object.hasOwn(table, group) && Object.hasOwn(table[group] ?? {}, method);
}

type MethodsOf<T> = T extends T ? T[keyof T] : never;

/** What a method the op table names can return. */
type Ran = ReturnType<
  MethodsOf<
    | Ops[Exclude<WorkerGroup, 'base'>]
    | Pick<Ops, keyof typeof WORKER_OPS.base>
    | Ops['hippoDb'][HippoDbRepo]
  >
>;

/** What holds the methods an op names: the store for a base op, else the op's group. */
type OpOwner = Ops | Ops[Exclude<WorkerGroup, 'base'>] | Ops['hippoDb'][HippoDbRepo];

function methodsOf(owner: OpOwner) {
  // SAFETY: every group is an object of methods, and the server thread sent the arguments the
  // port's own signature for the one called took.
  return owner as Readonly<Record<string, ((...sent: readonly unknown[]) => Ran) | undefined>>;
}

/** Runs `op`; only a method the op table places on a worker can run. */
function runOp(ops: Ops, op: string, args: readonly unknown[]) {
  const [group = '', method = '', local = ''] = op.split('.');
  const run =
    group === 'hippoDb'
      ? placed(HIPPO_DB_OPS, method, local) && methodsOf(ops.hippoDb[method])[local]
      : placed(WORKER_OPS, group, method) && methodsOf(group === 'base' ? ops : ops[group])[method];
  if (!run) throw new Error(`the store worker has no op '${op}'`);
  return run(...args);
}

/** The thread's store runtime and its one session, which every job opens through. */
interface Thread {
  readonly runtime: StoreRuntime;
  readonly stores: WorkerStores;
}

async function answer(ops: Ops, { stores }: Thread, hippoRoot: string, job: Job): Promise<Reply> {
  const failuresBefore = auditWriteFailureCount();
  stores.walPages = job.walPages;
  stores.jobId = job.id;
  try {
    const value = await runWithRequestId(job.requestId, () =>
      job.op === STORE_SETUP_OP
        ? initStore(hippoRoot, { session: stores })
        : runOp(ops, job.op, restoreAllTenants(job.args, job.allTenants)),
    );
    return {
      id: job.id,
      ok: true,
      value,
      auditFailures: auditWriteFailureCount() - failuresBefore,
    };
  } catch (err) {
    return {
      id: job.id,
      ok: false,
      error: encodeError(err),
      auditFailures: auditWriteFailureCount() - failuresBefore,
    };
  }
}

function post(port: MessagePort, reply: Reply, end: () => void): void {
  postReply(port, {
    reply,
    end,
    transfer: reply.ok && reply.value instanceof PackedVectors ? [reply.value.buffer] : [],
    failureOf: (err) =>
      ({
        id: reply.id,
        ok: false,
        error: encodeError(err),
        auditFailures: reply.auditFailures,
      }) satisfies Reply,
    what: `store worker: the reply to job ${reply.id}`,
  });
}

// Each step still closes what is left when the one before it throws, so a failed flush leaves no
// handle on the files. Held writes run first, then the thread's session closes, and dispose finds
// no session left to close twice.
function closeThread({ runtime, stores }: Thread, port: MessagePort): void {
  try {
    runtime.held.flush();
    stores.close();
  } finally {
    try {
      runtime.dispose();
    } finally {
      port.close();
    }
  }
}

/** Answers the thread's jobs until 'stop', which closes the connection so the thread ends with
 * no handle on the store's files. */
export function serveJobs(port: MessagePort, init: WorkerInit): void {
  // A thread is its own composition root: its runtime holds its mirror writes and closes its
  // connection at stop.
  const runtime = new StoreRuntime();
  const thread: Thread = { runtime, stores: new WorkerStores(init, runtime) };
  const graphs = init.pinned
    ? new VectorGraphs(init.hippoRoot, grantFor({ session: thread.stores }), {
        threshold: init.vectorGraphThreshold,
        maxVectors: init.vectorGraphMaxVectors,
      })
    : undefined;
  const ops = workerOps(init, graphs, thread.stores);
  // A thread is sent one job at a time, so only 'stop' can arrive while a vector scan yields, and
  // it waits for that job's reply.
  let last: Promise<void> = Promise.resolve();
  const stopThread = (): void => {
    graphs?.close();
    Promise.all([last, graphs?.idle()])
      .finally(() => closeThread(thread, port))
      .catch((err) => log.error('store worker: stopping the thread failed', errorFields(err)));
  };
  port.on('message', (message: Job | 'stop') => {
    if (message === 'stop') {
      stopThread();
      return;
    }
    // Ends in a catch, so `last` never rejects and skips the stop; a reply that cannot be posted
    // ends the thread, so the server rejects every call left.
    last = answer(ops, thread, init.hippoRoot, message)
      .then((reply) => post(port, reply, stopThread))
      .catch((err) =>
        log.error(`store worker: no reply was posted for job ${message.id}`, errorFields(err)),
      );
  });
}
