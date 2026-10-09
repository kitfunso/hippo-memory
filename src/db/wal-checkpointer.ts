// A served store's WAL is checkpointed on a worker thread: the fsync calls of a checkpoint would otherwise stall every request on the event loop.
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { errorMessage, log } from '../util/log.js';

// WAL pages at which a connection checkpoints inside its own commit.
const INLINE_CHECKPOINT_PAGES = 100;

// The same limit while a worker checkpoints the store: SQLite still bounds the WAL when the worker falls behind.
const BACKSTOP_CHECKPOINT_PAGES = 4000;

// Sized so one background checkpoint covers about 1000 WAL pages of recalls, SQLite's own default.
const RESPONSES_PER_CHECKPOINT = 32;

// After a checkpoint that left frames behind, a sooner retry keeps what an inline checkpoint would have to flush small.
const RESPONSES_PER_RETRY = 8;

// A commit that lands during a pass leaves frames behind, and only a WAL with none left can be reused from its start.
const MAX_PASSES = 4;

// CommonJS in a string, so the worker starts the same way from dist, vitest and strip-types, with no second entry file.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA busy_timeout = 5000');
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
  /** Counts one finished response and starts a checkpoint when enough have finished, unless one is still running. */
  noteResponse(): void;
  /** Resolves once the worker's connection is closed, so the caller's own close can be SQLite's last. */
  stop(): Promise<void>;
}

const backgrounded = new Set<string>();

/** The wal_autocheckpoint value for a new connection to `dbPath` in this process. */
export function autoCheckpointPages(dbPath: string): number {
  return backgrounded.has(path.resolve(dbPath)) ? BACKSTOP_CHECKPOINT_PAGES : INLINE_CHECKPOINT_PAGES;
}

/** Checkpoints `dbPath` off the calling thread until `stop()`; the worker starts with the first checkpoint that is due. */
export function startWalCheckpointer(dbPath: string): WalCheckpointer {
  const key = path.resolve(dbPath);
  let worker: Worker | undefined;
  let exited: Promise<void> | undefined;
  let running = false;
  let stopped = false;
  let responses = 0;
  let due = RESPONSES_PER_CHECKPOINT;
  backgrounded.add(key);

  const end = (): void => {
    stopped = true;
    backgrounded.delete(key);
  };
  const spawn = (): Worker => {
    // An explicit execArgv keeps the parent's loaders out of the worker and silences its repeat of the node:sqlite warning.
    const started = new Worker(WORKER_SOURCE, { eval: true, execArgv: ['--no-warnings'], workerData: { dbPath: key, maxPasses: MAX_PASSES } });
    started.unref();
    started.on('message', (settled: boolean) => {
      running = false;
      due = settled ? RESPONSES_PER_CHECKPOINT : RESPONSES_PER_RETRY;
    });
    started.on('error', (err) => {
      end();
      log.warn(`background checkpoint of ${key} stopped (${errorMessage(err)}); each connection checkpoints inside its own commit again`);
    });
    exited = new Promise<void>((resolve) => { started.once('exit', () => resolve()); });
    return started;
  };

  return {
    noteResponse(): void {
      if (stopped || ++responses < due || running) return;
      responses = 0;
      running = true;
      worker ??= spawn();
      worker.postMessage('checkpoint');
    },
    async stop(): Promise<void> {
      const live = !stopped;
      end();
      if (live) worker?.postMessage('stop');
      await exited;
    },
  };
}
