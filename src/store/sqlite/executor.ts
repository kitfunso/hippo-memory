// The server thread's side of the store workers: SQLite's synchronous statements and lock waits run on their threads, so the event loop keeps answering.
import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { addAuditWriteFailures } from '../audit.js';
import { getHippoDbPath, SERVER_DB_WAIT_MS, StoreBusyError } from '../../db.js';
import { autoCheckpointPages } from '../../db/wal-checkpointer.js';
import { envStoreQueueMax } from '../../env.js';
import { DeadlineExceededError } from '../../http-util.js';
import { errorMessage, log } from '../../log.js';
import { requestScopes } from '../../util/request-scope.js';
import { decodeError } from './error-codec.js';
import { workerCounts } from './executor-counts.js';
import { type Job, type OpMode, type Reply, STORE_SETUP_OP, type WorkerInit } from './worker-ops.js';

// Resolved from the package root, so a server run from TypeScript source starts the same built file.
const WORKER_ENTRY = fileURLToPath(new URL('../../../dist/store/sqlite/worker-entry.js', import.meta.url));

const WORKER_GONE = 'the store worker stopped before it answered; a write it was running may or may not be saved';
const EXECUTOR_CLOSED = 'the store is closed';
const QUEUE_FULL = 'the store worker has a full queue, so the call was refused before it ran';
const EXPIRED_WAITING = "the call was still waiting for a store worker at its request's deadline, so it never ran";
const READ_LATE = "the store did not answer the read by the request's deadline";
const WRITE_NOT_SAVED = "the store did not finish the write by the request's deadline; the write was stopped and nothing was saved";
const WRITE_UNKNOWN = "the store did not confirm the write by the request's deadline; it may or may not be saved";

// Far above any burst a healthy thread clears, small enough that a stuck thread refuses new work in bounded memory.
const DEFAULT_QUEUE_MAX = 256;

// How long past its deadline a write may still report its own outcome before the caller is told it is unknown.
const DEFAULT_WRITE_GRACE_MS = 2000;

export interface CallOptions {
  readonly mode: OpMode;
  readonly requestId: string | undefined;
  /** Epoch milliseconds by which the call's request must be answered; absent means the call waits as long as it takes. */
  readonly deadlineAt?: number | undefined;
}

export interface ExecutorOptions {
  /** Lock wait of each thread's connection; defaults to the server's. */
  readonly busyWaitMs?: number;
  /** Calls that may wait for one thread; defaults to HIPPO_STORE_QUEUE_MAX, else 256. */
  readonly queueMax?: number;
  /** How long past its deadline a write may still report its own outcome; defaults to 2000 ms. */
  readonly writeGraceMs?: number;
}

export interface SqliteExecutor {
  /** Runs `op` of the synchronous store on a worker thread. A throw there rejects here as an instance of its own class. */
  call<T>(op: string, args: readonly unknown[], opts: CallOptions): Promise<T>;
  /** Resolves once every thread has exited: Windows cannot delete a store folder while a thread holds its files. */
  close(): Promise<void>;
  /** Threads started and not yet exited. */
  liveThreads(): number;
  /** Stops the writer thread as a crash would: its running and queued calls reject, and the next write starts a fresh thread. */
  terminateWriter(): void;
}

interface Pending {
  readonly job: Omit<Job, 'walPages'>;
  readonly settle: (reply: Reply) => void;
  readonly fail: (err: Error) => void;
  readonly deadlineAt: number | undefined;
  timer: NodeJS.Timeout | undefined;
  /** Set once the caller has its answer, so nothing that happens to the job later reaches it. */
  answered: boolean;
}

/** One thread and the calls waiting for it; at most one job is on the thread at a time. */
interface Lane {
  readonly mode: OpMode;
  readonly queue: Pending[];
  running: Pending | undefined;
  worker: Worker | undefined;
  /** The thread while it is being stopped at a deadline; its job stays `running` until it has exited, so nothing is sent meanwhile. */
  stopping: Worker | undefined;
  /** The writer's commit flag: the id of the last job that may have committed. */
  commitFlag: Int32Array | undefined;
}

function laneOf(mode: OpMode): Lane {
  return { mode, queue: [], running: undefined, worker: undefined, stopping: undefined, commitFlag: undefined };
}

/** Gives `pending`'s caller its one answer; a second call does nothing. */
function finish(pending: Pending, answer: () => void): void {
  if (pending.answered) return;
  pending.answered = true;
  clearTimeout(pending.timer);
  answer();
}

function mayHaveCommitted(lane: Lane, pending: Pending): boolean {
  return lane.commitFlag !== undefined && Atomics.load(lane.commitFlag, 0) === pending.job.id;
}

function load(lane: Lane): number {
  return lane.queue.length + (lane.running === undefined ? 0 : 1);
}

class WorkerPool implements SqliteExecutor {
  readonly #hippoRoot: string;
  readonly #busyWaitMs: number;
  // One writer, so writes run in call order and never wait on each other's lock.
  readonly #writer = laneOf('write');
  readonly #readers = [laneOf('read'), laneOf('read')];
  // Keyed by thread and not by lane: close() must also wait for a thread its lane already replaced.
  readonly #exits = new Map<Worker, Promise<void>>();
  readonly #queueMax: number;
  readonly #writeGraceMs: number;
  #nextId = 1;
  #closed = false;
  // 'done' once the writer has run the store's open-time setup, which a reader's connection could not write.
  #setup: 'none' | 'running' | 'done' = 'none';

  constructor(hippoRoot: string, opts: ExecutorOptions) {
    this.#hippoRoot = hippoRoot;
    this.#busyWaitMs = opts.busyWaitMs ?? SERVER_DB_WAIT_MS;
    this.#queueMax = opts.queueMax ?? envStoreQueueMax() ?? DEFAULT_QUEUE_MAX;
    this.#writeGraceMs = opts.writeGraceMs ?? DEFAULT_WRITE_GRACE_MS;
  }

  call<T>(op: string, args: readonly unknown[], { mode, requestId, deadlineAt }: CallOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#closed) {
        reject(new StoreBusyError(EXECUTOR_CLOSED));
        return;
      }
      const settle = (reply: Reply): void => {
        if (!reply.ok) {
          reject(decodeError(reply.error));
          return;
        }
        // SAFETY: the worker ran `op` of the synchronous store, whose result is the T the caller's port method declares.
        resolve(reply.value as T);
      };
      const lane = mode === 'write' ? this.#writer : this.#readers.reduce((least, next) => (load(next) < load(least) ? next : least));
      const refusal = this.#refusal(lane, deadlineAt);
      if (refusal !== undefined) {
        reject(refusal);
        return;
      }
      const pending: Pending = { job: { id: this.#nextId++, op, args, requestId }, settle, fail: reject, deadlineAt, timer: undefined, answered: false };
      this.#watchDeadline(lane, pending);
      lane.queue.push(pending);
      this.#ensureSetup();
      this.#pump(lane);
    });
  }

  // Ahead of the call that started it, and with no deadline: the writer's own lock wait bounds it.
  #ensureSetup(): void {
    if (this.#setup !== 'none') return;
    this.#setup = 'running';
    const pending: Pending = {
      job: { id: this.#nextId++, op: STORE_SETUP_OP, args: [], requestId: undefined },
      settle: (reply) => this.#setupEnded(reply.ok ? undefined : decodeError(reply.error)),
      fail: (err) => this.#setupEnded(err),
      deadlineAt: undefined,
      timer: undefined,
      answered: false,
    };
    this.#writer.queue.unshift(pending);
    this.#pump(this.#writer);
  }

  // A failed setup fails the reads that waited for it with its own error, as each read's own open would have, and the next call tries it again.
  #setupEnded(failure: Error | undefined): void {
    this.#setup = failure === undefined ? 'done' : 'none';
    for (const lane of this.#readers) {
      if (failure !== undefined) for (const waiting of lane.queue.splice(0)) finish(waiting, () => waiting.fail(failure));
      this.#pump(lane);
    }
  }

  // Nothing is queued and nothing ran, so both refusals are the retryable 503 of a busy store.
  #refusal(lane: Lane, deadlineAt: number | undefined): StoreBusyError | undefined {
    if (lane.queue.length >= this.#queueMax) {
      workerCounts.queueRefusals += 1;
      return new StoreBusyError(QUEUE_FULL);
    }
    if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
      workerCounts.jobsExpired += 1;
      return new StoreBusyError(EXPIRED_WAITING);
    }
    return undefined;
  }

  #watchDeadline(lane: Lane, pending: Pending): void {
    if (pending.deadlineAt === undefined) return;
    pending.timer = setTimeout(() => this.#expire(lane, pending), pending.deadlineAt - Date.now());
    // The request that waits on the call keeps the process alive; this timer alone must not.
    pending.timer.unref();
  }

  #expire(lane: Lane, pending: Pending): void {
    workerCounts.jobsExpired += 1;
    const place = lane.queue.indexOf(pending);
    if (place >= 0) {
      lane.queue.splice(place, 1);
      finish(pending, () => pending.fail(new StoreBusyError(EXPIRED_WAITING)));
      return;
    }
    if (lane.running !== pending || lane.worker === undefined) return;
    log.warn(`the store's ${lane.mode} worker ran '${pending.job.op}' past its request's deadline`, { requestId: pending.job.requestId });
    if (lane.mode === 'read') this.#stopReader(lane, lane.worker, pending);
    else this.#stopWriter(lane, lane.worker, pending);
  }

  // A read changes nothing, so its caller is answered at once; the thread is replaced when it has exited.
  #stopReader(lane: Lane, worker: Worker, pending: Pending): void {
    finish(pending, () => pending.fail(new DeadlineExceededError(READ_LATE)));
    lane.stopping = worker;
    void worker.terminate();
  }

  // Before its commit flag a stopped write is a known rollback; after it the thread is left to finish, since stopping it could not undo the write.
  #stopWriter(lane: Lane, worker: Worker, pending: Pending): void {
    if (!mayHaveCommitted(lane, pending)) {
      lane.stopping = worker;
      this.terminateWriter();
    }
    // A statement in flight runs to its end even after the stop, so the caller waits for the thread's own word only this long.
    pending.timer = setTimeout(() => finish(pending, () => pending.fail(new DeadlineExceededError(WRITE_UNKNOWN))), this.#writeGraceMs);
    pending.timer.unref();
  }

  // The thread has exited, so the write lock is free and what the stopped job did is final.
  #replaceStopped(lane: Lane): void {
    const stopped = lane.running;
    lane.stopping = undefined;
    lane.running = undefined;
    workerCounts.workersReplaced += 1;
    if (stopped !== undefined) {
      // Read only now: the thread could still set its flag between the deadline and its exit.
      const message = mayHaveCommitted(lane, stopped) ? WRITE_UNKNOWN : WRITE_NOT_SAVED;
      finish(stopped, () => stopped.fail(new DeadlineExceededError(message)));
    }
    if (!this.#closed) this.#pump(lane);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const lane of [this.#writer, ...this.#readers]) {
      for (const pending of lane.queue.splice(0)) finish(pending, () => pending.fail(new StoreBusyError(EXECUTOR_CLOSED)));
      // An idle thread is unreferenced, and the process must not end before the thread has closed its connection.
      lane.worker?.ref();
      // Read after the reply of a job still running; the thread then closes its connection and ends.
      lane.worker?.postMessage('stop');
    }
    await Promise.all(this.#exits.values());
  }

  liveThreads(): number {
    return this.#exits.size;
  }

  terminateWriter(): void {
    void this.#writer.worker?.terminate();
  }

  #pump(lane: Lane): void {
    if (lane.running !== undefined) return;
    // Setup comes first: a reader sent a job before it would open a store whose setup it cannot write.
    if (lane.mode === 'read' && this.#setup !== 'done') return;
    const next = lane.queue.shift();
    if (next === undefined) return;
    // Started by the first call and never at boot, so a server that only answers /health opens no thread.
    // Outside that call's request scope, or the thread's listeners would log every later event under its request id.
    lane.worker ??= requestScopes.exit(() => this.#start(lane));
    lane.running = next;
    // An idle thread never keeps the process alive; one with a call in flight does.
    lane.worker.ref();
    try {
      lane.worker.postMessage({ ...next.job, walPages: autoCheckpointPages(getHippoDbPath(this.#hippoRoot)) } satisfies Job);
    } catch (err) {
      // Arguments that cannot be copied to the thread fail this call alone.
      this.#idle(lane, lane.worker);
      finish(next, () => next.fail(err instanceof Error ? err : new Error(errorMessage(err))));
      this.#pump(lane);
    }
  }

  #idle(lane: Lane, worker: Worker): void {
    lane.running = undefined;
    worker.unref();
  }

  #start(lane: Lane): Worker {
    // A fresh flag per thread: a job id left by the thread before it could match no later job, but a shared buffer would outlive its writer.
    const shared = lane.mode === 'write' ? new SharedArrayBuffer(4) : undefined;
    lane.commitFlag = shared && new Int32Array(shared);
    const init: WorkerInit = { hippoRoot: this.#hippoRoot, mode: lane.mode, busyWaitMs: this.#busyWaitMs, ...(shared && { commitFlag: shared }) };
    // An explicit execArgv keeps the parent's loaders out of the thread and silences its repeat of the node:sqlite warning.
    const worker = new Worker(WORKER_ENTRY, { env: SHARE_ENV, execArgv: ['--no-warnings'], workerData: init });
    worker.unref();
    worker.on('message', (reply: Reply) => this.#settle(lane, worker, reply));
    worker.on('error', (err) => this.#retire(lane, worker, err));
    const exited = new Promise<void>((resolve) => {
      worker.once('exit', () => {
        this.#exits.delete(worker);
        this.#retire(lane, worker);
        resolve();
      });
    });
    this.#exits.set(worker, exited);
    return worker;
  }

  #settle(lane: Lane, worker: Worker, reply: Reply): void {
    const done = lane.running;
    // A reply for a call that was already rejected with its thread has no caller left.
    if (lane.worker !== worker || done === undefined || done.job.id !== reply.id) return;
    addAuditWriteFailures(reply.auditFailures);
    finish(done, () => done.settle(reply));
    // A thread being stopped answered first; its lane stays taken until it has exited.
    if (lane.stopping === worker) return;
    this.#idle(lane, worker);
    this.#pump(lane);
  }

  // The lane keeps a stopped thread until it has exited, so a new thread never starts while the old one may still hold the write lock.
  #retire(lane: Lane, worker: Worker, cause?: Error): void {
    if (lane.worker !== worker) return;
    lane.worker = undefined;
    if (lane.stopping === worker) {
      // Stopped on purpose: the calls still waiting run on the replacement.
      this.#replaceStopped(lane);
      return;
    }
    const lost = lane.running === undefined ? lane.queue.splice(0) : [lane.running, ...lane.queue.splice(0)];
    lane.running = undefined;
    if (lost.length > 0 || cause !== undefined) {
      log.warn(`the store's ${lane.mode} worker stopped with ${lost.length} call(s) unanswered${cause === undefined ? '' : `: ${cause.message}`}`);
    }
    // The server answers this class as its retryable 503.
    for (const pending of lost) finish(pending, () => pending.fail(new StoreBusyError(WORKER_GONE, { cause })));
  }
}

/** Threads for the hippo.db under `hippoRoot`: one writer and two readers. The first call starts the writer for the store's setup; a reader starts at its own first call. */
export function createSqliteExecutor(hippoRoot: string, opts: ExecutorOptions = {}): SqliteExecutor {
  return new WorkerPool(hippoRoot, opts);
}
