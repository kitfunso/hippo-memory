import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { addAuditWriteFailures } from '../../../base/records/audit-report.js';
import type { StoreRules } from '../../../base/ports/infra.js';
import { getHippoDbPath, SERVER_DB_WAIT_MS } from '../../../db/index.js';
import { StoreBusyError } from '../../../base/ports/store.js';
import { autoCheckpointPages } from '../../../db/wal-checkpointer.js';
import { DeadlineExceededError } from '../../../base/errors/http-errors.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { requestScopes } from '../../../base/util/request-scope.js';
import { decodeError } from './error-codec.js';
import { portError } from './port-errors.js';
import { workerCounts } from './executor-counts.js';
import { markAllTenants } from './tenant-wire.js';
import type { StoreRuntime } from '../../../db/store-runtime.js';
import {
  type Job,
  type OpMode,
  type OpRoute,
  type Reply,
  STORE_SETUP_OP,
  type WorkerInit,
} from './worker-ops.js';

const WORKER_ENTRY = fileURLToPath(
  new URL('../../../../dist/store/sqlite/runtime/worker-entry.js', import.meta.url),
);

const WORKER_GONE =
  'the store worker stopped before it answered; a write it was running may or may not be saved';
const EXECUTOR_CLOSED = 'the store is closed';
const QUEUE_FULL = 'the store worker has a full queue, so the call was refused before it ran';
const EXPIRED_WAITING =
  "the call was still waiting for a store worker at its request's deadline, so it never ran";
const READ_LATE = "the store did not answer the read by the request's deadline";
const WRITE_NOT_SAVED =
  "the store did not finish the write by the request's deadline; the write was stopped and nothing was saved";
const WRITE_UNKNOWN =
  "the store did not confirm the write by the request's deadline; it may or may not be saved";

const DEFAULT_QUEUE_MAX = 256;

const DEFAULT_WRITE_GRACE_MS = 2000;

export interface CallOptions {
  readonly mode: OpRoute;
  readonly requestId: string | undefined;
  readonly deadlineAt?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The strength model and fake clock are the root's, which each thread's store opens with. */
export interface ExecutorOptions extends StoreRules {
  readonly busyWaitMs?: number;
  readonly queueMax?: number;
  readonly writeGraceMs?: number;
  readonly vectorGraphThreshold?: number;
  readonly vectorGraphMaxVectors?: number;
  readonly runtime?: StoreRuntime | undefined;
}

export interface SqliteExecutor {
  call<T>(op: string, args: readonly unknown[], opts: CallOptions): Promise<T>;
  close(): Promise<void>;
  liveThreads(): number;
  terminateWriter(): void;
}

interface Pending {
  readonly job: Omit<Job, 'walPages'>;
  readonly settle: (reply: Reply) => void;
  readonly fail: (err: Error) => void;
  readonly deadlineAt: number | undefined;
  readonly signal?: AbortSignal | undefined;
  timer: NodeJS.Timeout | undefined;
  answered: boolean;
}

interface Lane {
  readonly mode: OpMode;
  readonly pinned: boolean;
  readonly queue: Pending[];
  running: Pending | undefined;
  worker: Worker | undefined;
  stopping: Worker | undefined;
  commitFlag: Int32Array | undefined;
}

function laneOf(mode: OpMode, pinned = false): Lane {
  return {
    mode,
    pinned,
    queue: [],
    running: undefined,
    worker: undefined,
    stopping: undefined,
    commitFlag: undefined,
  };
}

function terminateLogged(worker: Worker): void {
  worker
    .terminate()
    .catch(<E>(err: E) => log.warn('the store worker did not terminate cleanly', errorFields(err)));
}

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
  readonly #writer = laneOf('write');
  readonly #readers = [laneOf('read', true), laneOf('read')];
  readonly #exits = new Map<Worker, Promise<void>>();
  readonly #queueMax: number;
  readonly #writeGraceMs: number;
  readonly #vectorGraphThreshold: number | undefined;
  readonly #vectorGraphMaxVectors: number | undefined;
  readonly #rules: StoreRules;
  readonly #runtime: StoreRuntime | undefined;
  #nextId = 1;
  #closed = false;
  #setup: 'none' | 'running' | 'done' = 'none';

  constructor(hippoRoot: string, opts: ExecutorOptions) {
    this.#hippoRoot = hippoRoot;
    this.#busyWaitMs = opts.busyWaitMs ?? SERVER_DB_WAIT_MS;
    this.#queueMax = opts.queueMax ?? DEFAULT_QUEUE_MAX;
    this.#writeGraceMs = opts.writeGraceMs ?? DEFAULT_WRITE_GRACE_MS;
    this.#vectorGraphThreshold = opts.vectorGraphThreshold;
    this.#vectorGraphMaxVectors = opts.vectorGraphMaxVectors;
    this.#rules = { strength: opts.strength, fakeNowMs: opts.fakeNowMs };
    this.#runtime = opts.runtime;
  }

  call<T>(
    op: string,
    args: readonly unknown[],
    { mode, requestId, deadlineAt, signal }: CallOptions,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#closed) {
        reject(new StoreBusyError(EXECUTOR_CLOSED));
        return;
      }
      const settle = (reply: Reply): void => {
        if (!reply.ok) {
          reject(portError(decodeError(reply.error)));
          return;
        }
        // SAFETY: the worker ran `op` of the synchronous store, whose result is the T the caller's
        // port method declares.
        resolve(reply.value as T);
      };
      const lane = this.#laneFor(mode);
      const refusal = this.#refusal(lane, deadlineAt);
      if (refusal !== undefined) {
        reject(refusal);
        return;
      }
      const pending: Pending = {
        job: { id: this.#nextId++, op, ...markAllTenants(args), requestId },
        settle,
        fail: reject,
        deadlineAt,
        signal,
        timer: undefined,
        answered: false,
      };
      this.#watchDeadline(lane, pending);
      lane.queue.push(pending);
      this.#ensureSetup();
      this.#pump(lane);
    });
  }

  #laneFor(mode: OpRoute): Lane {
    if (mode === 'write') return this.#writer;
    const [pinned, other] = this.#readers;
    if (mode === 'pinned-read') return pinned;
    return load(pinned) < load(other) ? pinned : other;
  }

  #ensureSetup(): void {
    if (this.#setup !== 'none') return;
    this.#setup = 'running';
    const pending: Pending = {
      job: {
        id: this.#nextId++,
        op: STORE_SETUP_OP,
        args: [],
        allTenants: [],
        requestId: undefined,
      },
      settle: (reply) =>
        this.#setupEnded(reply.ok ? undefined : portError(decodeError(reply.error))),
      fail: (err) => this.#setupEnded(err),
      deadlineAt: undefined,
      timer: undefined,
      answered: false,
    };
    this.#writer.queue.unshift(pending);
    this.#pump(this.#writer);
  }

  #setupEnded(failure: Error | undefined): void {
    this.#setup = failure === undefined ? 'done' : 'none';
    for (const lane of this.#readers) {
      if (failure !== undefined) {
        for (const waiting of lane.queue.splice(0)) finish(waiting, () => waiting.fail(failure));
      }
      this.#pump(lane);
    }
  }

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
    log.warn(
      `the store's ${lane.mode} worker ran '${pending.job.op}' past its request's deadline`,
      {
        requestId: pending.job.requestId,
      },
    );
    if (lane.mode === 'read') this.#stopReader(lane, lane.worker, pending);
    else this.#stopWriter(lane, lane.worker, pending);
  }

  #stopReader(lane: Lane, worker: Worker, pending: Pending): void {
    finish(pending, () => pending.fail(new DeadlineExceededError(READ_LATE)));
    lane.stopping = worker;
    terminateLogged(worker);
  }

  #stopWriter(lane: Lane, worker: Worker, pending: Pending): void {
    if (!mayHaveCommitted(lane, pending)) {
      lane.stopping = worker;
      this.terminateWriter();
    }
    pending.timer = setTimeout(
      () => finish(pending, () => pending.fail(new DeadlineExceededError(WRITE_UNKNOWN))),
      this.#writeGraceMs,
    );
    pending.timer.unref();
  }

  #replaceStopped(lane: Lane): void {
    const stopped = lane.running;
    lane.stopping = undefined;
    lane.running = undefined;
    workerCounts.workersReplaced += 1;
    if (stopped !== undefined) {
      const message = mayHaveCommitted(lane, stopped) ? WRITE_UNKNOWN : WRITE_NOT_SAVED;
      finish(stopped, () => stopped.fail(new DeadlineExceededError(message)));
    }
    if (!this.#closed) this.#pump(lane);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const lane of [this.#writer, ...this.#readers]) {
      for (const pending of lane.queue.splice(0)) {
        finish(pending, () => pending.fail(new StoreBusyError(EXECUTOR_CLOSED)));
      }
      lane.worker?.ref();
      lane.worker?.postMessage('stop');
    }
    await Promise.all(this.#exits.values());
  }

  liveThreads(): number {
    return this.#exits.size;
  }

  terminateWriter(): void {
    if (this.#writer.worker) terminateLogged(this.#writer.worker);
  }

  #pump(lane: Lane): void {
    if (lane.running !== undefined) return;
    if (lane.mode === 'read' && this.#setup !== 'done') return;
    let next = lane.queue.shift();
    while (next?.signal?.aborted) {
      workerCounts.jobsExpired += 1;
      const dropped = next;
      finish(dropped, () => dropped.fail(new StoreBusyError(EXPIRED_WAITING)));
      next = lane.queue.shift();
    }
    if (next === undefined) return;
    lane.worker ??= requestScopes.exit(() => this.#start(lane));
    lane.running = next;
    lane.worker.ref();
    try {
      lane.worker.postMessage({
        ...next.job,
        walPages: autoCheckpointPages(getHippoDbPath(this.#hippoRoot), this.#runtime),
      } satisfies Job);
    } catch (err) {
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
    const shared = lane.mode === 'write' ? new SharedArrayBuffer(4) : undefined;
    lane.commitFlag = shared && new Int32Array(shared);
    const init: WorkerInit = {
      hippoRoot: this.#hippoRoot,
      mode: lane.mode,
      busyWaitMs: this.#busyWaitMs,
      rules: this.#rules,
      ...(shared && { commitFlag: shared }),
      ...(lane.pinned && {
        pinned: true,
        vectorGraphThreshold: this.#vectorGraphThreshold,
        vectorGraphMaxVectors: this.#vectorGraphMaxVectors,
      }),
    };
    // An explicit execArgv keeps the parent's loaders out of the thread and silences its repeat of
    // the node:sqlite warning.
    const worker = new Worker(WORKER_ENTRY, {
      env: SHARE_ENV,
      execArgv: ['--no-warnings'],
      workerData: init,
    });
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
    if (lane.worker !== worker || done === undefined || done.job.id !== reply.id) return;
    addAuditWriteFailures(reply.auditFailures);
    finish(done, () => done.settle(reply));
    if (lane.stopping === worker) return;
    this.#idle(lane, worker);
    this.#pump(lane);
  }

  #retire(lane: Lane, worker: Worker, cause?: Error): void {
    if (lane.worker !== worker) return;
    lane.worker = undefined;
    if (lane.stopping === worker) {
      this.#replaceStopped(lane);
      return;
    }
    const lost =
      lane.running === undefined ? lane.queue.splice(0) : [lane.running, ...lane.queue.splice(0)];
    lane.running = undefined;
    if (lost.length > 0 || cause !== undefined) {
      log.warn(
        `the store's ${lane.mode} worker stopped with ${lost.length} call(s) ` +
          `unanswered${cause === undefined ? '' : `: ${cause.message}`}`,
        cause === undefined ? undefined : errorFields(cause),
      );
    }
    for (const pending of lost) {
      finish(pending, () => pending.fail(new StoreBusyError(WORKER_GONE, { cause })));
    }
  }
}

/** Threads for the hippo.db under `hippoRoot`: one writer and two readers. The first call starts
 * the writer for the store's setup; a reader starts at its own first call. */
export function createSqliteExecutor(
  hippoRoot: string,
  opts: ExecutorOptions = {},
): SqliteExecutor {
  return new WorkerPool(hippoRoot, opts);
}
