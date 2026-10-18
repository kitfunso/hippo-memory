// What crosses between the server thread and a store worker, and which kind of worker runs each store method.
import type { HippoStore, StoreGroups } from '../port.js';
import type { WireError } from './error-codec.js';

/** 'write' runs on the one writer thread; 'read' on a reader, whose connection refuses every write. */
export type OpMode = 'read' | 'write';

/** Where the executor sends a call: by its mode, or 'pinned-read' for a read only the first reader runs, since that
 * thread alone holds the store's vector graph and a second copy would double its memory. */
export type OpRoute = OpMode | 'pinned-read';

/** 'server' keeps a method on the calling thread: it takes a function, and a function cannot be copied to a thread. */
export type OpPlace = OpRoute | 'server';

export type OpPlaces<G> = { readonly [M in keyof G]: OpPlace };

type BaseMethods = Omit<HippoStore, keyof StoreGroups | 'kind' | 'close'>;

/** Every store method but hippo.db's local files, so a served store runs no SQLite on the server thread. Tagged by
 * effect: predictionBaserate (audit row) and bumpRecallStats (stats.json) write; an `openStore` read is a read, as the
 * writer runs that open's setup before any reader serves. */
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
    nearestEntries: 'pinned-read',
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
    setPinned: 'write',
    supersede: 'write',
    archiveRaw: 'write',
    forget: 'write',
  },
  contextReads: {
    unfinishedHandoff: 'read',
    ambientCandidates: 'read',
    contextCandidates: 'read',
    ambientTallies: 'read',
    newestEntries: 'read',
    schemaFit: 'read',
    liveContentsBySourceAndTag: 'read',
    rawRowsUnderRef: 'read',
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
    summaryWithDescendants: 'read',
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
    entitiesForMemories: 'read',
    entitiesByIds: 'read',
    neighborRelations: 'read',
    storedGraph: 'read',
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
    objectIdByMemory: 'read',
  },
  readiness: {
    ping: 'read',
  },
  keyGrants: {
    changeScopeGrant: 'write',
  },
  connectorWrites: {
    writeConnectorEntry: 'write',
    archiveConnectorEntry: 'write',
  },
  connectorEvents: {
    eventRecord: 'read',
    markEventSeen: 'write',
    deletionTarget: 'read',
    archiveDeletedArtifact: 'write',
    slackTeamRoute: 'read',
    githubRouting: 'read',
    parkDeadLetter: 'write',
    deadLetters: 'read',
    deadLetter: 'read',
    markDeadLetterRetried: 'write',
    slackCursor: 'read',
    saveSlackCursor: 'write',
    githubCursors: 'read',
    saveGitHubHwm: 'write',
    seedGitHubCursors: 'write',
    slackWorkspaces: 'read',
    registerSlackWorkspace: 'write',
    removeSlackWorkspace: 'write',
  },
  // finishRecall strengthens the global store's rows too, from the writer thread of this one.
  lastRecall: {
    applyTracedOutcome: 'write',
    applyOutcomeToLast: 'write',
    finishRecall: 'write',
  },
  auditMaintenance: {
    objectBackedIds: 'read',
    deleteAutomatically: 'write',
    pruneAuditRows: 'write',
    repairQuality: 'write',
    repairQualityOnce: 'write',
  },
  lessonWrites: {
    textsHoldingWords: 'read',
    contentsWithTag: 'read',
    writeSkippingRejected: 'write',
    writeTogether: 'write',
    bumpRemembered: 'write',
  },
  // Both snapshot loads rewrite the active-task mirror file, so they run on the one writer.
  sessions: {
    saveSnapshot: 'write',
    loadSnapshot: 'write',
    loadFreshSnapshot: 'write',
    clearSnapshot: 'write',
    closeSessionSnapshots: 'write',
    appendEvent: 'write',
    listEvents: 'read',
    saveHandoff: 'write',
    latestHandoff: 'read',
    handoffById: 'read',
    stampHandoffOutcome: 'write',
    writeSessionEndHandoff: 'write',
    pushWorkingMemory: 'write',
    readWorkingMemory: 'read',
    clearWorkingMemory: 'write',
    bindSessionOwner: 'write',
  },
  cards: {
    create: 'write',
    load: 'read',
    detail: 'read',
    list: 'read',
    runs: 'read',
    claim: 'write',
    heartbeat: 'write',
    block: 'write',
    review: 'write',
    complete: 'write',
    reclaimExpired: 'write',
    comment: 'write',
  },
  goals: {
    push: 'write',
    sessionGoals: 'read',
    complete: 'write',
    suspend: 'write',
    resume: 'write',
  },
  conflicts: {
    list: 'read',
    get: 'read',
    resolve: 'write',
  },
  dormant: {
    list: 'read',
    holds: 'read',
    restore: 'server',
    forget: 'write',
  },
  reports: {
    tokenUse: 'read',
    failures: 'read',
    memoryStatus: 'read',
    entriesPage: 'read',
    countEntries: 'read',
    stats: 'read',
    statusCounts: 'read',
    correctionEntries: 'read',
    rawEntries: 'read',
    createdSinceLastSleep: 'read',
  },
  rejections: {
    apply: 'server',
    lift: 'write',
    list: 'read',
    refusedAmong: 'read',
  },
  failureLog: {
    record: 'write',
    requestOutcome: 'read',
    settleOutcome: 'write',
  },
  compactions: {
    start: 'write',
    markSnapshotSaved: 'write',
    saveCallerItems: 'write',
  },
} as const satisfies { readonly [G in Exclude<keyof StoreGroups, 'localFiles'>]: OpPlaces<StoreGroups[G]> } & {
  readonly base: OpPlaces<BaseMethods>;
};

/** Sent by the executor itself and by no store method: the writer runs the store's open-time setup once, before any
 * reader is sent a job. */
export const STORE_SETUP_OP = 'setup';

export type WorkerGroup = keyof typeof WORKER_OPS;

/** The base methods the op table names. */
export type WorkerBase = Pick<HippoStore, keyof typeof WORKER_OPS.base>;

export interface WorkerInit {
  readonly hippoRoot: string;
  readonly mode: OpMode;
  /** Lock wait of the thread's connection. */
  readonly busyWaitMs: number;
  /** Set on the first reader alone, which answers 'pinned-read' calls from the vector graph it holds. */
  readonly pinned?: boolean;
  /** Stored vectors a store holds before the pinned reader builds its graph; 20,000 when omitted. */
  readonly vectorGraphThreshold?: number | undefined;
  /** One shared integer the writer sets to a job's id before that job may commit; the server thread reads it when the
   * job passes its deadline. */
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

/** Both kinds carry the audit rows the job failed to write,
 * since the count `/health` reports lives on the server thread. */
export type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown; readonly auditFailures: number }
  | { readonly id: number; readonly ok: false; readonly error: WireError; readonly auditFailures: number };
