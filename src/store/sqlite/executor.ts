// The server thread's side of the store workers: SQLite's synchronous statements and lock waits run on their threads, so the event loop keeps answering.
import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { addAuditWriteFailures } from '../../audit.js';
import { getHippoDbPath, SERVER_DB_WAIT_MS, StoreBusyError } from '../../db.js';
import { autoCheckpointPages } from '../../db/wal-checkpointer.js';
import { errorMessage, log } from '../../log.js';
import { requestScopes } from '../../util/request-scope.js';
import { decodeError } from './error-codec.js';
import type { Job, OpMode, Reply, WorkerInit } from './worker-ops.js';

// Resolved from the package root, so a server run from TypeScript source starts the same built file.
const WORKER_ENTRY = fileURLToPath(new URL('../../../dist/store/sqlite/worker-entry.js', import.meta.url));

const WORKER_GONE = 'the store worker stopped before it answered; a write it was running may or may not be saved';
const EXECUTOR_CLOSED = 'the store is closed';

export interface CallOptions {
  readonly mode: OpMode;
  readonly requestId: string | undefined;
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
}

/** One thread and the calls waiting for it; at most one job is on the thread at a time. */
interface Lane {
  readonly mode: OpMode;
  readonly queue: Pending[];
  running: Pending | undefined;
  worker: Worker | undefined;
}

function laneOf(mode: OpMode): Lane {
  return { mode, queue: [], running: undefined, worker: undefined };
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
  #nextId = 1;
  #closed = false;

  constructor(hippoRoot: string, busyWaitMs: number) {
    this.#hippoRoot = hippoRoot;
    this.#busyWaitMs = busyWaitMs;
  }

  call<T>(op: string, args: readonly unknown[], { mode, requestId }: CallOptions): Promise<T> {
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
      lane.queue.push({ job: { id: this.#nextId++, op, args, requestId }, settle, fail: reject });
      this.#pump(lane);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const lane of [this.#writer, ...this.#readers]) {
      for (const pending of lane.queue.splice(0)) pending.fail(new StoreBusyError(EXECUTOR_CLOSED));
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
      next.fail(err instanceof Error ? err : new Error(errorMessage(err)));
      this.#pump(lane);
    }
  }

  #idle(lane: Lane, worker: Worker): void {
    lane.running = undefined;
    worker.unref();
  }

  #start(lane: Lane): Worker {
    const init: WorkerInit = { hippoRoot: this.#hippoRoot, mode: lane.mode, busyWaitMs: this.#busyWaitMs };
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
    this.#idle(lane, worker);
    addAuditWriteFailures(reply.auditFailures);
    done.settle(reply);
    this.#pump(lane);
  }

  // The lane keeps a stopped thread until it has exited, so a new thread never starts while the old one may still hold the write lock.
  #retire(lane: Lane, worker: Worker, cause?: Error): void {
    if (lane.worker !== worker) return;
    lane.worker = undefined;
    const lost = lane.running === undefined ? lane.queue.splice(0) : [lane.running, ...lane.queue.splice(0)];
    lane.running = undefined;
    if (lost.length > 0 || cause !== undefined) {
      log.warn(`the store's ${lane.mode} worker stopped with ${lost.length} call(s) unanswered${cause === undefined ? '' : `: ${cause.message}`}`);
    }
    // The server answers this class as its retryable 503.
    for (const pending of lost) pending.fail(new StoreBusyError(WORKER_GONE, { cause }));
  }
}

/** Threads for the hippo.db under `hippoRoot`: one writer and two readers, each started by its first call. `busyWaitMs` defaults to the server's lock wait. */
export function createSqliteExecutor(hippoRoot: string, opts: { readonly busyWaitMs?: number } = {}): SqliteExecutor {
  return new WorkerPool(hippoRoot, opts.busyWaitMs ?? SERVER_DB_WAIT_MS);
}
