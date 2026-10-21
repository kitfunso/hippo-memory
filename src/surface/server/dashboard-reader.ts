// The dashboard's reads answered from one thread of their own: each runs a synchronous aggregate over a tenant's rows,
// so on the server thread it would hold every other request.
import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { MemoryQuery } from '../../api/dashboard/queries.js';
import type { MemoryDetail, MemoryPage, Overview, ProjectDetail, SearchResult } from '../../api/dashboard/types.js';
import { StoreBusyError } from '../../store/port.js';
import { errorFields, log } from '../../base/util/log.js';

/** What the dashboard routes read; each call is dated by the dashboard's clocks when it is sent. */
export interface DashboardReader {
  overview(fresh: boolean): Promise<Overview>;
  project(key: string, fresh: boolean): Promise<ProjectDetail | null>;
  memories(key: string, query: MemoryQuery, fresh: boolean): Promise<MemoryPage | null>;
  search(text: string, fresh: boolean): Promise<SearchResult>;
  memory(id: string, fresh: boolean): Promise<MemoryDetail | null>;
  /** After a dashboard write: moves the snapshot id when it committed, and answers the detail of `entry` when given. */
  written(changed: boolean, entry?: MemoryEntry): Promise<MemoryDetail | null>;
  close(): Promise<void>;
}

/** One piece of work for the thread. */
export type ReaderOp =
  | { readonly op: 'overview'; readonly fresh: boolean }
  | { readonly op: 'project'; readonly key: string; readonly fresh: boolean }
  | { readonly op: 'memories'; readonly key: string; readonly query: MemoryQuery; readonly fresh: boolean }
  | { readonly op: 'search'; readonly text: string; readonly fresh: boolean }
  | { readonly op: 'memory'; readonly memoryId: string; readonly fresh: boolean }
  | { readonly op: 'written'; readonly changed: boolean; readonly entry?: MemoryEntry }
  | { readonly op: 'close' };

/** An op as sent, with its id and the clock readings it runs at. */
export type ReaderCall = ReaderOp & { readonly id: number; readonly nowMs: number; readonly wallMs: number };

/** What a call answers: the value of the DashboardReader method that sent it. */
export type ReaderValue = Overview | ProjectDetail | MemoryPage | SearchResult | MemoryDetail | null;

export type ReaderReply =
  | { readonly id: number; readonly ok: true; readonly value: ReaderValue }
  | {
      readonly id: number;
      readonly ok: false;
      readonly busy: boolean;
      readonly message: string;
      readonly stack?: string;
    };

/** What the thread starts with. */
export interface ReaderInit {
  readonly hippoRoot: string;
  readonly tenantId: string;
}

export interface ReaderClocks {
  /** Dates the strength projections. */
  readonly now: () => number;
  /** Ages the snapshot id. */
  readonly cacheClock: () => number;
}

// Resolved from the package root, so a server run from TypeScript source starts the same built file.
const THREAD_ENTRY = fileURLToPath(new URL('../../../dist/surface/server/dashboard-reader-thread.js', import.meta.url));

const READER_GONE = 'the dashboard reader has stopped';

interface Pending {
  readonly resolve: (value: ReaderValue) => void;
  readonly reject: (err: Error) => void;
}

function failureOf(reply: Extract<ReaderReply, { ok: false }>): Error {
  // A lock the thread could not get is the same retryable 503 a served route gives.
  if (reply.busy) return new StoreBusyError(reply.message);
  const failure = new Error(reply.message);
  if (reply.stack) failure.stack = reply.stack;
  return failure;
}

/** The thread's calls in flight, and why it stopped once it has. */
interface ReaderState {
  readonly pending: Map<number, Pending>;
  gone?: Error;
}

/** Settles each call from the thread's reply, and every call left once the thread exits; resolves on that exit. */
function settleReplies(worker: Worker, state: ReaderState): Promise<void> {
  worker.on('message', (reply: ReaderReply) => {
    const waiting = state.pending.get(reply.id);
    state.pending.delete(reply.id);
    if (reply.ok) waiting?.resolve(reply.value);
    else waiting?.reject(failureOf(reply));
  });
  worker.on('error', (err) => {
    log.error(`dashboard: the reader thread failed: ${err.message}`, errorFields(err));
    state.gone = new StoreBusyError(READER_GONE, { cause: err });
  });
  return new Promise<void>((resolve) => {
    worker.once('exit', () => {
      const gone = (state.gone ??= new StoreBusyError(READER_GONE));
      for (const waiting of state.pending.values()) waiting.reject(gone);
      state.pending.clear();
      resolve();
    });
  });
}

/** Starts the reader thread for `init`'s tenant; close() lets it close its store and waits for it to exit. */
export function startDashboardReader(init: ReaderInit, clocks: ReaderClocks): DashboardReader {
  // An explicit execArgv keeps the parent's loaders out of the thread and silences its repeat of Node's
  // experimental-module warning.
  const worker = new Worker(THREAD_ENTRY, { env: SHARE_ENV, execArgv: ['--no-warnings'], workerData: init });
  // The listener keeps the process alive; the thread alone must not.
  worker.unref();
  const state: ReaderState = { pending: new Map() };
  const exited = settleReplies(worker, state);
  let nextId = 0;
  const call = <T extends ReaderValue>(op: ReaderOp): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (state.gone !== undefined) return reject(state.gone);
      const id = ++nextId;
      // SAFETY: the thread answers each op with the value its DashboardReader method names, which is T below.
      state.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      const sent: ReaderCall = { ...op, id, nowMs: clocks.now(), wallMs: clocks.cacheClock() };
      worker.postMessage(sent);
    });
  return {
    overview: (fresh) => call({ op: 'overview', fresh }),
    project: (key, fresh) => call({ op: 'project', key, fresh }),
    memories: (key, query, fresh) => call({ op: 'memories', key, query, fresh }),
    search: (text, fresh) => call({ op: 'search', text, fresh }),
    memory: (memoryId, fresh) => call({ op: 'memory', memoryId, fresh }),
    written: (changed, entry) => call({ op: 'written', changed, ...(entry !== undefined && { entry }) }),
    close: async () => {
      // The process must not end before the thread has closed its store, as when a failed listen leaves nothing else.
      worker.ref();
      if (state.gone === undefined) await call<null>({ op: 'close' });
      await exited;
    },
  };
}
