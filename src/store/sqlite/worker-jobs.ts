// A store worker's side of the executor: one job at a time, on one connection the thread holds for its life.
import type { MessagePort } from 'node:worker_threads';
import { auditWriteFailureCount } from '../audit.js';
import { type DatabaseSyncLike, RequestStores } from '../../db.js';
import { isScopedHandle } from '../../db/request-stores.js';
import { requestScopes } from '../../util/request-scope.js';
import { encodeError } from './error-codec.js';
import { sqliteSyncStore } from './store.js';
import { type Job, type Reply, type WorkerGroup, type WorkerInit, WORKER_OPS } from './worker-ops.js';

type SyncStore = ReturnType<typeof sqliteSyncStore>;

/** The scope every job of a thread runs in, so each open inside a job gets the thread's one connection. */
class WorkerStores extends RequestStores {
  override requestId: string | undefined = undefined;
  walPages: number | undefined;
  readonly #init: WorkerInit;
  readonly #prepared = new WeakSet<DatabaseSyncLike>();
  readonly #walPagesOn = new WeakMap<DatabaseSyncLike, number>();
  readonly #held = new Set<DatabaseSyncLike>();

  constructor(init: WorkerInit) {
    super({ busyWaitMs: init.busyWaitMs });
    this.#init = init;
  }

  override get(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
    const db = super.get(hippoRoot, opts);
    if (!this.#prepared.has(db)) {
      this.#prepared.add(db);
      // A reader that could write would let a method wrongly tagged 'read' take the write lock off the writer thread.
      if (this.#init.mode === 'read') db.exec('PRAGMA query_only = ON');
      if (isScopedHandle(db)) this.#held.add(db);
    }
    // The connection set its own value from this thread's state, where no checkpointer ever runs.
    if (hippoRoot === this.#init.hippoRoot && this.walPages !== undefined && this.#walPagesOn.get(db) !== this.walPages) {
      db.exec(`PRAGMA wal_autocheckpoint = ${this.walPages}`);
      this.#walPagesOn.set(db, this.walPages);
    }
    return db;
  }

  /** A job that left a transaction open: the scope would hand every later open a fresh connection, and the lock would stay taken. */
  get inTransaction(): boolean {
    for (const db of this.#held) {
      if (db.isOpen !== false && db.isTransaction) return true;
    }
    return false;
  }
}

function isWorkerGroup(group: string): group is WorkerGroup {
  return Object.hasOwn(WORKER_OPS, group);
}

function isMethodOf<G extends WorkerGroup>(group: G, method: string): method is string & keyof (typeof WORKER_OPS)[G] {
  return Object.hasOwn(WORKER_OPS[group], method);
}

/** Runs `op` of the synchronous store; only a method the op table lists can run. */
function runOp(sync: SyncStore, op: string, args: readonly unknown[]) {
  const [group = '', method = ''] = op.split('.');
  if (!isWorkerGroup(group) || !isMethodOf(group, method)) throw new Error(`the store worker has no op '${op}'`);
  const typed = sync[group][method];
  // SAFETY: the server thread sent the arguments the port's own signature for this method took.
  const run = typed as (...sent: readonly unknown[]) => ReturnType<typeof typed>;
  return run(...args);
}

function answer(sync: SyncStore, stores: WorkerStores, job: Job): Reply {
  const failuresBefore = auditWriteFailureCount();
  stores.requestId = job.requestId;
  stores.walPages = job.walPages;
  try {
    const value = requestScopes.run(stores, () => runOp(sync, job.op, job.args));
    return { id: job.id, ok: true, value, auditFailures: auditWriteFailureCount() - failuresBefore };
  } catch (err) {
    return { id: job.id, ok: false, error: encodeError(err), auditFailures: auditWriteFailureCount() - failuresBefore };
  }
}

function post(port: MessagePort, reply: Reply): void {
  try {
    port.postMessage(reply);
  } catch (err) {
    // A result that cannot be copied to the server thread must still answer, or its caller would wait for ever.
    port.postMessage({ id: reply.id, ok: false, error: encodeError(err), auditFailures: reply.auditFailures } satisfies Reply);
  }
}

/** Answers the thread's jobs until 'stop', which closes the connection so the thread ends with no handle on the store's files. */
export function serveJobs(port: MessagePort, init: WorkerInit): void {
  const sync = sqliteSyncStore(init.hippoRoot);
  let stores = new WorkerStores(init);
  port.on('message', (message: Job | 'stop') => {
    if (message === 'stop') {
      stores.close();
      port.close();
      return;
    }
    const reply = answer(sync, stores, message);
    if (stores.inTransaction) {
      // Closing rolls the transaction back; the next job opens a clean connection.
      stores.close();
      stores = new WorkerStores(init);
    }
    post(port, reply);
  });
}
