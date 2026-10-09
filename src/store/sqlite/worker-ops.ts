// What crosses between the server thread and a store worker, and which kind of worker runs each store method.
import type { HippoStore, StoreGroups } from '../port.js';
import type { WireError } from './error-codec.js';

/** 'write' runs on the one writer thread; 'read' on a reader, whose connection refuses every write. */
export type OpMode = 'read' | 'write';

/** 'server' keeps a method on the calling thread: it takes a function, and a function cannot be copied to a thread. */
export type OpPlace = OpMode | 'server';

export type OpPlaces<G> = { readonly [M in keyof G]: OpPlace };

type BaseMethods = Omit<HippoStore, keyof StoreGroups | 'kind' | 'close'>;

/** The store methods that answer from a worker, the base ones under `base`. Tagged by effect, not by name: predictionBaserate appends an audit row, so it is a write,
 *  and so is a read that opens through `openStore`, which records the half-life base and imports legacy rows on a store with no memory. */
export const WORKER_OPS = {
  // SHORTCUT: every openStore-backed read is tagged 'write', so it queues behind real writes on the one writer thread; run store setup once on the writer before readers serve, then tag them 'read'.
  base: {
    findApiKey: 'read',
    entriesByIds: 'write',
    recordTokens: 'write',
  },
  keyAudit: {
    revokeApiKey: 'write',
    auditEventsAfter: 'read',
    auditHighId: 'read',
  },
  keyWrites: {
    createApiKey: 'write',
    createSelfApiKey: 'write',
    listApiKeys: 'read',
  },
  entryWrites: {
    writeEntry: 'write',
    applyOutcome: 'write',
    supersede: 'write',
    archiveRaw: 'write',
    forget: 'write',
  },
  predictions: {
    savePrediction: 'write',
    closePrediction: 'write',
    predictionById: 'read',
    listPredictions: 'read',
    predictionBaserate: 'write',
  },
  dagReads: {
    sessionRawEntries: 'write',
    sessionRawCount: 'write',
    summaryWithDescendants: 'server',
  },
  auditLog: {
    listAuditEvents: 'read',
  },
} as const satisfies { readonly [G in keyof StoreGroups]?: OpPlaces<StoreGroups[G]> } & { readonly base: Partial<OpPlaces<BaseMethods>> };

export type WorkerGroup = keyof typeof WORKER_OPS;

/** The base methods the op table names. */
export type WorkerBase = Pick<HippoStore, keyof typeof WORKER_OPS.base>;

export interface WorkerInit {
  readonly hippoRoot: string;
  readonly mode: OpMode;
  /** Lock wait of the thread's connection. */
  readonly busyWaitMs: number;
  /** One shared integer the writer sets to a job's id before that job may commit; the server thread reads it when the job passes its deadline. */
  readonly commitFlag?: SharedArrayBuffer;
}

export interface Job {
  readonly id: number;
  /** `<group>.<method>` of the synchronous store, `base.<method>` for a base one. */
  readonly op: string;
  readonly args: readonly unknown[];
  /** Of the request the call belongs to, so the thread's log lines carry it. */
  readonly requestId: string | undefined;
  /** wal_autocheckpoint as the server thread has it: a worker cannot see the checkpointer start or stop. */
  readonly walPages: number;
}

/** Both kinds carry the audit rows the job failed to write, since the count `/health` reports lives on the server thread. */
export type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown; readonly auditFailures: number }
  | { readonly id: number; readonly ok: false; readonly error: WireError; readonly auditFailures: number };
