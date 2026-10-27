// What crosses between the server thread and a store worker, and which kind of worker runs each
// store method.
import type { BaseMethods, HippoStore, StoreGroups } from '../../base/ports/store.js';
import type { WireError } from './error-codec.js';
import type { TenantMark } from './tenant-wire.js';
import type { StoreRules } from '../../base/ports/infra.js';

/** 'write' runs on the one writer thread; 'read' on a reader, whose connection refuses every
 * write. */
export type OpMode = 'read' | 'write';

/** Where the executor sends a call: by its mode, or 'pinned-read' for a read only the first
 * reader runs, since that thread alone holds the store's vector graph and a second copy would
 * double its memory. */
export type OpRoute = OpMode | 'pinned-read';

export type OpPlaces<G> = { readonly [M in keyof G]: OpRoute };

/** Every store method but hippo.db's local files, so a served store runs no SQLite on the server
 * thread. Tagged by effect: predictionBaserate (audit row), bumpRecallStats and bumpRemembered
 * (stats.json) write; an `openStore` read is a read, as the writer runs that open's setup before
 * any reader serves. */
export const WORKER_OPS = {
  base: {
    findApiKey: 'read',
    searchRecallEntries: 'read',
    entriesByIds: 'read',
    entriesWhere: 'read',
    activeGoals: 'read',
    freshRawEntries: 'read',
    continuity: 'read',
    planningFallacyEvidence: 'read',
    appendAuditEvents: 'write',
    finishRecall: 'write',
    bumpRecallStats: 'write',
    bumpRemembered: 'write',
    recordTokens: 'write',
  },
  vectors: {
    embeddingIndexState: 'read',
    stored: 'read',
    nearestEntries: 'pinned-read',
  },
  keyWrites: {
    changeApiKey: 'write',
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
    ambientCandidates: 'read',
    contextCandidates: 'read',
    ambientTallies: 'read',
    schemaFit: 'read',
  },
  dagReads: {
    sessionRawCount: 'read',
    summaryWithDescendants: 'read',
  },
  auditLog: {
    listAuditEvents: 'read',
  },
  quarantine: {
    listQuarantined: 'read',
    decideQuarantined: 'write',
  },
  graphReads: {
    graphRows: 'read',
    graphDelta: 'read',
  },
  objects: {
    listObjects: 'read',
    objectById: 'read',
    closeObject: 'write',
    saveObject: 'write',
    briefReceipts: 'read',
    predictionBaserate: 'write',
  },
  readiness: {
    ping: 'read',
  },
  connectorWrites: {
    writeConnectorEntry: 'write',
    archiveConnectorEntry: 'write',
  },
  connectorEvents: {
    eventRecord: 'read',
    markEventSeen: 'write',
    claimDelivery: 'write',
    releaseDelivery: 'write',
    route: 'read',
    parkDeadLetter: 'write',
    deadLetters: 'read',
    markDeadLetterRetried: 'write',
    cursor: 'read',
    saveCursor: 'write',
    slackWorkspaces: 'read',
    registerSlackWorkspace: 'write',
    removeSlackWorkspace: 'write',
  },
  // finishRecall strengthens the global store's rows too, from the writer thread of this one.
  lastRecall: {
    applyOutcomeToLast: 'write',
    finishRecall: 'write',
  },
  auditMaintenance: {
    objectBackedAmong: 'read',
    deleteAutomatically: 'write',
    pruneAuditRows: 'write',
    repairQuality: 'write',
    repairQualityOnce: 'write',
  },
  lessonWrites: {
    textsHolding: 'read',
    contentsWithTag: 'read',
    writeSkippingRejected: 'write',
    writeTogether: 'write',
  },
  // A snapshot load rewrites the active-task mirror file, so it runs on the one writer.
  sessions: {
    save: 'write',
    read: 'read',
    clear: 'write',
    loadSnapshot: 'write',
    bindSessionOwner: 'write',
  },
  cards: {
    create: 'write',
    detail: 'read',
    list: 'read',
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
    restore: 'write',
    forget: 'write',
  },
  reports: {
    tokenUse: 'read',
    failures: 'read',
    memoryStatus: 'read',
    countEntries: 'read',
    stats: 'read',
    statusCounts: 'read',
    correctionLinks: 'read',
    rawProvenance: 'read',
    createdSinceLastSleep: 'read',
  },
  rejections: {
    apply: 'write',
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
  ledger: {
    recordTurn: 'write',
    lastSent: 'read',
    pilotArm: 'write',
    replaceRereads: 'write',
  },
  // A session's lock token and staged vectors sit on the thread that opened it, so every index call
  // goes to the writer.
  embeddingIndex: {
    open: 'write',
    step: 'write',
  },
  promotion: {
    writeCopy: 'write',
  },
  folderFiles: {
    ensure: 'write',
    home: 'read',
  },
  sharing: {
    entriesWithSignals: 'read',
    textKeysPage: 'read',
    textKeysHolding: 'read',
    takenIds: 'read',
    sourceTallies: 'read',
    searchEntries: 'read',
    recallEntries: 'read',
  },
  consolidation: {
    begin: 'write',
    entryIdsPage: 'read',
    rejected: 'read',
    particleIds: 'read',
    saveParticles: 'write',
    dirtySummaries: 'read',
    unprofiledTopicSummaries: 'read',
    settleSummary: 'write',
    commit: 'write',
    recordSleep: 'write',
    auditEachRow: 'write',
    duplicateCandidates: 'read',
    dirtyGraphTenants: 'read',
    markGraphDrained: 'write',
  },
  learning: {
    entriesMentioning: 'read',
    readEntry: 'read',
    addTagToEntries: 'write',
    confirmedOutcomeTimes: 'read',
  },
  captures: {
    write: 'write',
    textsHolding: 'read',
  },
  compactionHooks: {
    start: 'write',
    markSnapshotSaved: 'write',
    save: 'write',
    saveStalled: 'write',
    recordSpooled: 'write',
    saveRecordItems: 'write',
    openRecords: 'read',
    fill: 'write',
  },
  projectTags: {
    originTallies: 'read',
    dormantWhere: 'read',
    compactionOrigins: 'read',
    merge: 'write',
    repair: 'write',
    repairedOnce: 'read',
    markRepairedOnce: 'write',
  },
  diagnostics: {
    health: 'read',
    inventory: 'read',
  },
  graphRebuild: {
    applyOps: 'write',
  },
  agentImport: {
    applyContainer: 'write',
  },
} as const satisfies { readonly [G in keyof StoreGroups]: OpPlaces<StoreGroups[G]> } & {
  readonly base: OpPlaces<BaseMethods>;
};

/** Sent by the executor itself and by no store method: the writer runs the store's open-time
 * setup once, before any reader is sent a job. */
export const STORE_SETUP_OP = 'setup';

export type WorkerGroup = keyof typeof WORKER_OPS;

/** The base methods the op table names. */
export type WorkerBase = Pick<HippoStore, keyof typeof WORKER_OPS.base>;

export interface WorkerInit {
  readonly hippoRoot: string;
  readonly mode: OpMode;
  /** Lock wait of the thread's connection. */
  readonly busyWaitMs: number;
  /** Set on the first reader alone, which answers 'pinned-read' calls from the vector graph it
   * holds. */
  readonly pinned?: boolean;
  /** Stored vectors a store holds before the pinned reader builds its graph;
   * VECTOR_GRAPH_THRESHOLD when omitted. */
  readonly vectorGraphThreshold?: number | undefined;
  /** Stored vectors past which the pinned reader keeps no graph; the config default when
   * omitted. */
  readonly vectorGraphMaxVectors?: number | undefined;
  /** One shared integer the writer sets to a job's id before that job may commit; the server
   * thread reads it when the job passes its deadline. */
  readonly commitFlag?: SharedArrayBuffer;
  /** The strength model and fake clock the parent's root opened with, which the thread's store
   * opens with. */
  readonly rules: StoreRules;
}

export interface Job {
  readonly id: number;
  /** `<group>.<method>` of the synchronous store, `base.<method>` for a base one. */
  readonly op: string;
  readonly args: readonly unknown[];
  /** Where ALL_TENANTS sat in the arguments, since a symbol cannot be copied to the thread. */
  readonly allTenants: readonly TenantMark[];
  /** Of the request the call belongs to, so the thread's log lines carry it. */
  readonly requestId: string | undefined;
  /** wal_autocheckpoint as the server thread has it: a worker cannot see the checkpointer start
   * or stop. */
  readonly walPages: number;
}

/** Both kinds carry the audit rows the job failed to write, since the count `/health` reports
 * lives on the server thread. */
export type Reply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly value: unknown;
      readonly auditFailures: number;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: WireError;
      readonly auditFailures: number;
    };
