import { fileURLToPath } from 'node:url';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { MemoryQuery } from '../../api/dashboard/queries.js';
import type {
  MemoryDetail,
  MemoryPage,
  Overview,
  ProjectDetail,
  SearchResult,
} from '../../api/dashboard/types.js';
import { StoreBusyError } from '../../base/ports/store.js';
import { errorFields, log } from '../../base/util/log.js';
import { replyError, type FailureReply } from './failure-reply.js';

/** What the dashboard routes read; each call is dated by the dashboard's clocks when it is sent. */
export interface DashboardReader {
  overview(fresh: boolean): Promise<Overview>;
  project(key: string, fresh: boolean): Promise<ProjectDetail | null>;
  memories(key: string, query: MemoryQuery, fresh: boolean): Promise<MemoryPage | null>;
  search(text: string, fresh: boolean): Promise<SearchResult>;
  memory(id: string, fresh: boolean): Promise<MemoryDetail | null>;
  written(changed: boolean, entry?: MemoryEntry): Promise<MemoryDetail | null>;
  close(): Promise<void>;
}

/** One piece of work for the thread. */
export type ReaderOp =
  | { readonly op: 'overview'; readonly fresh: boolean }
  | { readonly op: 'project'; readonly key: string; readonly fresh: boolean }
  | {
      readonly op: 'memories';
      readonly key: string;
      readonly query: MemoryQuery;
      readonly fresh: boolean;
    }
  | { readonly op: 'search'; readonly text: string; readonly fresh: boolean }
  | { readonly op: 'memory'; readonly memoryId: string; readonly fresh: boolean }
  | { readonly op: 'written'; readonly changed: boolean; readonly entry?: MemoryEntry }
  | { readonly op: 'close' };

/** An op as sent, with its id and the clock readings it runs at. */
export type ReaderCall = ReaderOp & {
  readonly id: number;
  readonly nowMs: number;
  readonly wallMs: number;
};

/** What a call answers: the value of the DashboardReader method that sent it. */
export type ReaderValue =
  | Overview
  | ProjectDetail
  | MemoryPage
  | SearchResult
  | MemoryDetail
  | null;

export type ReaderReply =
  | { readonly id: number; readonly ok: true; readonly value: ReaderValue }
  | (FailureReply & { readonly id: number });

/** What the thread starts with. */
export interface ReaderInit {
  readonly hippoRoot: string;
  readonly tenantId: string;
}

export interface ReaderClocks {
  readonly now: () => number;
  readonly cacheClock: () => number;
}

const THREAD_ENTRY = fileURLToPath(
  new URL('../../../dist/surface/server/dashboard-reader-thread.js', import.meta.url),
);

const READER_GONE = 'the dashboard reader has stopped';

interface Pending {
  readonly resolve: (value: ReaderValue) => void;
  readonly reject: (err: Error) => void;
}

interface ReaderState {
  readonly pending: Map<number, Pending>;
  gone?: Error;
}

function settleReplies(worker: Worker, state: ReaderState): Promise<void> {
  worker.on('message', (reply: ReaderReply) => {
    const waiting = state.pending.get(reply.id);
    state.pending.delete(reply.id);
    if (reply.ok) waiting?.resolve(reply.value);
    else waiting?.reject(replyError(reply));
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

/** Starts the reader thread for `init`'s tenant; close() lets it close its store and waits for
 * it to exit. */
export function startDashboardReader(init: ReaderInit, clocks: ReaderClocks): DashboardReader {
  // An explicit execArgv keeps the parent's loaders out of the thread and silences its repeat of
  // Node's experimental-module warning.
  const worker = new Worker(THREAD_ENTRY, {
    env: SHARE_ENV,
    execArgv: ['--no-warnings'],
    workerData: init,
  });
  worker.unref();
  const state: ReaderState = { pending: new Map() };
  const exited = settleReplies(worker, state);
  let nextId = 0;
  const call = <T extends ReaderValue>(op: ReaderOp): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (state.gone !== undefined) return reject(state.gone);
      const id = ++nextId;
      // SAFETY: the thread answers each op with the value its DashboardReader method names, which
      // is T below.
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
    written: (changed, entry) =>
      call({ op: 'written', changed, ...(entry !== undefined && { entry }) }),
    close: async () => {
      worker.ref();
      if (state.gone === undefined) await call<null>({ op: 'close' });
      await exited;
    },
  };
}
