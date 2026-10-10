// What crosses between the server thread and a store worker, and which kind of worker runs each store method.
import type { HippoStore, StoreGroups } from '../port.js';
import type { WireError } from './error-codec.js';

/** 'write' runs on the one writer thread; 'read' on a reader, whose connection refuses every write. */
export type OpMode = 'read' | 'write';

/** 'server' keeps a method on the calling thread: it takes a function, and a function cannot be copied to a thread. */
export type OpPlace = OpMode | 'server';

export type OpPlaces<G> = { readonly [M in keyof G]: OpPlace };

type BaseMethods = Omit<HippoStore, keyof StoreGroups | 'kind' | 'close'>;

/** Store methods answered by a worker, base ones under `base`. Tagged by effect, not name: predictionBaserate (audit row) and bumpRecallStats
 * (stats.json) are writes. A read that opens through `openStore` is a read: the writer runs that open's setup before any reader serves. */
export const WORKER_OPS = {
  base: {
    findApiKey: 'read',
    searchRecallEntries: 'read',
    entriesByIds: 'read',
    activeGoals: 'read',
    freshRawEntries: 'read',
    continuity: 'read',
    planningFallacyEvidence: 'read',
    appendAuditEvents: 'write',
    finishRecall: 'write',
    bumpRecallStats: 'write',
    recordTokens: 'write',
  },
  vectors: {
    embeddingIndexState: 'read',
    storedVectors: 'read',
    nearestEntries: 'read',
    physicsParticles: 'read',
  },
  vectorViews: {
    storedVectorViews: 'read',
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
  vectorWrites: {
    entriesWithoutVector: 'read',
    writeVectors: 'write',
  },
  entryWrites: {
    writeEntry: 'write',
    applyOutcome: 'write',
    supersede: 'write',
    archiveRaw: 'write',
    forget: 'write',
  },
  contextReads: {
    unfinishedHandoff: 'read',
    ambientCandidates: 'server',
    contextCandidates: 'read',
    ambientTallies: 'read',
  },
  predictions: {
    savePrediction: 'write',
    closePrediction: 'write',
    predictionById: 'read',
    listPredictions: 'read',
    predictionBaserate: 'write',
  },
  dagReads: {
    sessionRawEntries: 'read',
    sessionRawCount: 'read',
    summaryWithDescendants: 'server',
  },
  auditLog: {
    listAuditEvents: 'read',
  },
  quarantine: {
    listQuarantined: 'read',
    approveQuarantined: 'write',
    rejectQuarantined: 'write',
  },
  graphReads: {
    graphRows: 'read',
  },
  objects: {
    listObjects: 'read',
    objectById: 'read',
    closeObject: 'write',
    saveObject: 'write',
    openIncident: 'write',
    resolveIncident: 'write',
    policiesInForce: 'read',
    activeSkillsByName: 'read',
    briefReceipts: 'read',
  },
  readiness: {
    ping: 'read',
  },
} as const satisfies { readonly [G in keyof StoreGroups]?: OpPlaces<StoreGroups[G]> } & { readonly base: Partial<OpPlaces<BaseMethods>> };

/** Sent by the executor itself and by no store method: the writer runs the store's open-time setup once, before any reader is sent a job. */
export const STORE_SETUP_OP = 'setup';

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
