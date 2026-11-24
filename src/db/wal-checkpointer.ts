import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { DEFAULT_BUSY_WAIT_MS } from './busy.js';
import type { StoreRuntime } from './store-runtime.js';

const INLINE_CHECKPOINT_PAGES = 1000;

const BACKSTOP_CHECKPOINT_PAGES = 4000;

const RESPONSES_PER_CHECKPOINT = 32;

const RESPONSES_PER_RETRY = 8;

const MAX_PASSES = 4;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA busy_timeout = ${DEFAULT_BUSY_WAIT_MS}');
db.exec('PRAGMA synchronous = NORMAL');
const pass = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
parentPort.on('message', (message) => {
  if (message === 'stop') {
    db.close();
    parentPort.close();
    return;
  }
  let seen = -1;
  let settled = false;
  for (let n = 0; n < workerData.maxPasses && !settled; n++) {
    const { busy, log, checkpointed } = pass.get();
    if (busy) break;
    settled = log === seen && checkpointed === log;
    seen = log;
  }
  parentPort.postMessage(settled);
});
`;

export interface WalCheckpointer {
  noteResponse(): void;
  stop(): Promise<void>;
}

/** The wal_autocheckpoint value for a new connection to `dbPath` under `runtime`. */
export function autoCheckpointPages(dbPath: string, runtime: StoreRuntime | undefined): number {
  return runtime?.checkpointsInBackground(path.resolve(dbPath))
    ? BACKSTOP_CHECKPOINT_PAGES
    : INLINE_CHECKPOINT_PAGES;
}

interface CheckpointWorker {
  readonly worker: Worker;
  readonly exited: Promise<void>;
}

/** An explicit execArgv keeps the parent's loaders out of the worker and silences its repeat of
 * the node:sqlite warning. */
function newCheckpointWorker(
  key: string,
  onSettled: (settled: boolean) => void,
  onFailed: () => void,
): CheckpointWorker {
  const started = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: ['--no-warnings'],
    workerData: { dbPath: key, maxPasses: MAX_PASSES },
  });
  started.unref();
  started.on('message', onSettled);
  started.on('error', (err) => {
    onFailed();
    log.warn(
      `background checkpoint of ${key} stopped (${errorMessage(err)}); ` +
        `each connection checkpoints inside its own commit again`,
      errorFields(err),
    );
  });
  const exited = new Promise<void>((resolve) => {
    started.once('exit', () => resolve());
  });
  return { worker: started, exited };
}

interface CheckpointerState {
  worker?: Worker;
  exited?: Promise<void>;
  running: boolean;
  stopped: boolean;
  responses: number;
  due: number;
}

function spawnCheckpointWorker(key: string, state: CheckpointerState, end: () => void): Worker {
  const settle = (settled: boolean): void => {
    state.running = false;
    state.due = settled ? RESPONSES_PER_CHECKPOINT : RESPONSES_PER_RETRY;
  };
  const started = newCheckpointWorker(key, settle, end);
  state.exited = started.exited;
  return started.worker;
}

/**
 * Checkpoints `dbPath` off the calling thread until `stop()`; the worker starts with the first
 * checkpoint that is due. Connections `runtime` opens meanwhile leave checkpoints to it; outside a
 * runtime they still checkpoint inline.
 */
export function startWalCheckpointer(
  dbPath: string,
  runtime: StoreRuntime | undefined,
): WalCheckpointer {
  const key = path.resolve(dbPath);
  const state: CheckpointerState = {
    running: false,
    stopped: false,
    responses: 0,
    due: RESPONSES_PER_CHECKPOINT,
  };
  runtime?.markBackground(key, true);

  const end = (): void => {
    state.stopped = true;
    runtime?.markBackground(key, false);
  };

  return {
    noteResponse(): void {
      if (state.stopped || ++state.responses < state.due || state.running) return;
      state.responses = 0;
      state.running = true;
      state.worker ??= spawnCheckpointWorker(key, state, end);
      state.worker.postMessage('checkpoint');
    },
    async stop(): Promise<void> {
      const live = !state.stopped;
      end();
      state.worker?.ref();
      if (live) state.worker?.postMessage('stop');
      await state.exited;
    },
  };
}
