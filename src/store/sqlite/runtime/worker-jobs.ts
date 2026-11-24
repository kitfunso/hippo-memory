import type { MessagePort } from 'node:worker_threads';
import { auditWriteFailureCount } from '../../../base/records/audit-report.js';
import { type DatabaseSyncLike, RequestStores } from '../../../db/index.js';
import { SESSION_OPEN } from '../../../db/request-stores.js';
import { type OpenedDb, shutWriteGate } from '../../../db/connect.js';
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
  type Job,
  type OpRoute,
  type Reply,
  STORE_SETUP_OP,
  type WorkerGroup,
  type WorkerInit,
  WORKER_OPS,
} from './worker-ops.js';

function workerOps(
  { hippoRoot, rules }: WorkerInit,
  graphs: VectorGraphs | undefined,
  session: WorkerStores,
) {
  const handles = handlesOf(hippoRoot, { ...rules, session });
  const store = sqliteStoreOn(handles);
  const vectors = sqliteVectorReads(handles, graphs);
  const stored = async (part: StoredPart, ids: readonly string[]) =>
    part === 'vectors' ? packVectors(await vectors.stored(part, ids)) : vectors.stored(part, ids);
  return { ...store, vectors: { ...vectors, stored } };
}

type Ops = ReturnType<typeof workerOps>;

class WorkerStores extends RequestStores {
  walPages: number | undefined;
  jobId = 0;
  readonly #init: WorkerInit;
  readonly #commitFlag: Int32Array | undefined;
  readonly #prepared = new WeakSet<DatabaseSyncLike>();
  readonly #walPagesOn = new WeakMap<DatabaseSyncLike, number>();

  constructor(init: WorkerInit, runtime: StoreRuntime) {
    super({
      runtime,
      busyWaitMs: init.busyWaitMs,
      ...(init.mode === 'read' && { setupDoneFor: init.hippoRoot }),
    });
    this.#init = init;
    this.#commitFlag = init.commitFlag && new Int32Array(init.commitFlag);
  }

  override [SESSION_OPEN](hippoRoot: string, opts?: { busyWaitMs?: number }): OpenedDb {
    const opened = super[SESSION_OPEN](hippoRoot, opts);
    const { db } = opened;
    if (!this.#prepared.has(db)) {
      this.#prepared.add(db);
      if (this.#init.mode === 'read') shutWriteGate(db);
      const flag = this.#commitFlag;
      if (flag) watchCommits(db, () => Atomics.store(flag, 0, this.jobId));
    }
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

function isWorkerGroup(group: string): group is WorkerGroup {
  return Object.hasOwn(WORKER_OPS, group);
}

function runsOnWorker(group: WorkerGroup, method: string): boolean {
  const places: Readonly<Record<string, OpRoute>> = WORKER_OPS[group];
  return Object.hasOwn(places, method);
}

type MethodsOf<T> = T extends T ? NonNullable<T[keyof T]> : never;

type Ran = ReturnType<
  MethodsOf<Ops[Exclude<WorkerGroup, 'base'>] | Pick<Ops, keyof typeof WORKER_OPS.base>>
>;

function methodsOf(ops: Ops, group: WorkerGroup) {
  // SAFETY: every group is an object of methods, and the server thread sent the arguments the
  // port's own signature for the one called took.
  return (group === 'base' ? ops : ops[group]) as Readonly<
    Record<string, ((...sent: readonly unknown[]) => Ran) | undefined>
  >;
}

function runOp(ops: Ops, op: string, args: readonly unknown[]) {
  const [group = '', method = ''] = op.split('.');
  const run =
    isWorkerGroup(group) && runsOnWorker(group, method) ? methodsOf(ops, group)[method] : undefined;
  if (run === undefined) throw new Error(`the store worker has no op '${op}'`);
  return run(...args);
}

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

function closeThread({ runtime, stores }: Thread, port: MessagePort): void {
  try {
    runtime.held.flush();
    stores.close();
  } finally {
    try {
      runtime.closeNow();
    } finally {
      port.close();
    }
  }
}

/** Answers the thread's jobs until 'stop', which closes the connection so the thread ends with
 * no handle on the store's files. */
export function serveJobs(port: MessagePort, init: WorkerInit): void {
  const runtime = new StoreRuntime();
  const thread: Thread = { runtime, stores: new WorkerStores(init, runtime) };
  const graphs = init.pinned
    ? new VectorGraphs(init.hippoRoot, grantFor({ session: thread.stores }), {
        threshold: init.vectorGraphThreshold,
        maxVectors: init.vectorGraphMaxVectors,
      })
    : undefined;
  const ops = workerOps(init, graphs, thread.stores);
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
    last = answer(ops, thread, init.hippoRoot, message)
      .then((reply) => post(port, reply, stopThread))
      .catch((err) =>
        log.error(`store worker: no reply was posted for job ${message.id}`, errorFields(err)),
      );
  });
}
