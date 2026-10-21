// The async store interface and its groups: every method answers a Promise and takes only data, so any backend can
// serve it from any thread, and hippo.db is one adapter. Type-only apart from the group probes and the store errors.
import { StoreNotPortedError } from '../base/util/store-blocked.js';
import type { SessionAndAdminGroups } from './port-groups.js';
import type { MemoryEntry } from '../base/memory/memory.js';
import type { TenantId } from '../base/util/tenant.js';
import type { TokenUse } from './port/token-ledger.js';
import type { SessionEvent, TaskSnapshot } from './port/sessions.js';
import type { SessionHandoff } from '../base/session/handoff.js';
import type { AuditMaintenance } from './port/audit-maintenance.js';
import type { LessonWrites } from './port/lesson-writes.js';
import type { VectorReads } from './port/vector-reads.js';
import type { VectorViews } from './port/vector-views.js';
import type { KeyAudit } from './port/key-audit.js';
import type { KeyWrites } from './port/key-writes.js';
import type { KeyGrants } from './port/key-grants.js';
import type { VectorWrites } from './port/vector-writes.js';
import type { EntryWrites } from './port/entry-writes.js';
import type { ContextReads } from './port/context-reads.js';
import type { Predictions } from './port/predictions.js';
import type { DagReads } from './port/dag-reads.js';
import type { AuditLog } from './port/audit-log.js';
import type { Quarantine } from './port/quarantine.js';
import type { GraphReads } from './port/graph-reads.js';
import type { Objects } from './port/objects.js';
import type { Readiness } from './port/readiness.js';
import type { LastRecall } from './port/last-recall.js';
import type { RecallSearchArgs, RecallWrites } from './port/recall-writes.js';
import type { ConnectorEvents, ConnectorWrites } from './port/connectors.js';
import type { Ledger } from './port/ledger.js';
import type { EmbeddingIndex } from './port/embedding-index.js';
import type { Promotion } from './port/promotion.js';
import type { FolderFiles } from './port/folder-files.js';
import type { Sharing } from './port/sharing.js';
import type { Consolidation } from './port/consolidation.js';
import type { Learning } from './port/learning.js';
import type { Captures } from './port/captures.js';
import type { CompactionHooks } from './port/compaction-hooks.js';
import type { ProjectTags } from './port/project-tags.js';
import type { Diagnostics } from './port/diagnostics.js';
import type { GraphRebuild } from './port/graph-rebuild.js';
import type { AgentImport } from './port/agent-import.js';
export type { FolderStore, GlobalTargetGroup, StoreReach } from './port/reach.js';
import type {
  ApiKeyRecord,
  ActiveGoals,
  GetActiveGoalsOpts,
  ContinuityKey,
  PlanningFallacyEvidence,
  AppendAuditOpts,
} from './port/types.js';

/** Every group a store has: the required ones, then five optional capabilities, each a set of groups a store sets or
 * leaves unset together. */
export interface StoreGroups
  extends RequiredGroups, FallbackGroups, FolderGroups, SleepGroups, CaptureGroups, MaintenanceGroups {}

/** The groups a store may leave unset, each with a fallback or a 501 where it is missing. */
export type OptionalGroup = keyof (FallbackGroups & FolderGroups & SleepGroups & CaptureGroups & MaintenanceGroups);

/** The groups a sleep runs on. */
export type SleepGroup = keyof SleepGroups;

/** Groups a store may skip for a fallback: recall scores the plain vectors, GET /ready answers 200 with
 * `store: "unchecked"`, and context writes no last recall for the CLI's no-ids outcome to read. */
export interface FallbackGroups {
  readonly vectorViews: VectorViews;
  readonly readiness: Readiness;
  readonly lastRecall: LastRecall;
}

/** A store kept as files in a folder; without these, init, share, sync down and promote answer 501. */
export interface FolderGroups {
  readonly folderFiles: FolderFiles;
  /** The rows a folder store shares with the operator's global store. */
  readonly sharing: Sharing;
  /** Set on the operator's global store, which promote copies into. */
  readonly promotion: Promotion;
  /** Unset, embedding goes through `vectors` and `vectorWrites`. */
  readonly embeddingIndex: EmbeddingIndex;
  /** Unset, a hook books no rows and every session takes the hash arm. */
  readonly ledger: Ledger;
}

/** Sleep's reads and writes; without them, sleep and consolidate answer 501. */
export interface SleepGroups {
  /** Over every tenant. */
  readonly consolidation: Consolidation;
  /** The learn passes. */
  readonly learning: Learning;
  readonly graphRebuild: GraphRebuild;
}

/** `hippo capture` and the compaction hooks, which a store without them refuses. */
export interface CaptureGroups {
  /** Capture's writes and its dedup read. */
  readonly captures: Captures;
  /** The compaction hooks' records and their replay. */
  readonly compactionHooks: CompactionHooks;
}

/** What `hippo doctor`, the project repair and the agent-memories import read and write. */
export interface MaintenanceGroups {
  /** The project names a store holds, listed, folded and repaired. */
  readonly projectTags: ProjectTags;
  /** The store's own files, as `hippo doctor` and `hippo status` read them. */
  readonly diagnostics: Diagnostics;
  /** The import's reads and its container writes. */
  readonly agentImport: AgentImport;
}

/** Every group a store sets whole. */
interface RequiredGroups extends SessionAndAdminGroups {
  readonly auditMaintenance: AuditMaintenance;
  readonly lessonWrites: LessonWrites;
  readonly vectors: VectorReads;
  readonly keyAudit: KeyAudit;
  readonly keyWrites: KeyWrites;
  /** The CLI's auth grant and ungrant. */
  readonly keyGrants: KeyGrants;
  /** embedMemory and embedAll with a store need it and `vectors`. */
  readonly vectorWrites: VectorWrites;
  readonly entryWrites: EntryWrites;
  readonly contextReads: ContextReads;
  readonly predictions: Predictions;
  readonly dagReads: DagReads;
  readonly auditLog: AuditLog;
  readonly quarantine: Quarantine;
  readonly graphReads: GraphReads;
  /** A write that carries a connector event or untrusted content. */
  readonly connectorWrites: ConnectorWrites;
  /** Both connector webhooks' dedup, dead letters and tenant routing. */
  readonly connectorEvents: ConnectorEvents;
  readonly objects: Objects;
}

/** A store a sleep can run on. */
export type SleepStore = StoreWith<SleepGroup>;

export type StoreGroup = 'base' | keyof StoreGroups;

/** True when the store sets `group`; for an optional group the store is narrowed to one that does. */
export function hasGroup<G extends OptionalGroup>(store: HippoStore, group: G): store is StoreWith<G>;
export function hasGroup(store: HippoStore, group: StoreGroup): boolean;
export function hasGroup(store: HippoStore, group: StoreGroup): boolean {
  return group === 'base' || store[group] !== undefined;
}

/** The optional group's methods; a store without them throws
 * StoreNotPortedError, which answers 501 as any unported path does. */
export function requireGroup<G extends OptionalGroup>(store: HippoStore, group: G): StoreGroups[G] {
  const groups: Partial<StoreGroups> = store;
  const methods = groups[group];
  if (methods === undefined) throw new StoreNotPortedError(store.kind, group);
  return methods;
}

/** A store that sets the optional groups `G`, as a surface proves once before it calls in. */
export type StoreWith<G extends OptionalGroup> = HippoStore & Pick<StoreGroups, G>;

export { isStoreBusy, STORE_BUSY_MESSAGE, StoreBusyError } from './port/busy.js';

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an await, since a lock wait
 * blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore extends Omit<StoreGroups, OptionalGroup>, Partial<Pick<StoreGroups, OptionalGroup>> {
  /** A name for logs and errors; what a store can do beyond the required groups is the optional ones it sets. */
  readonly kind: string;
  /** The API key record for `keyId` with its scope grants, revoked or not; null when none matches. */
  findApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** Recall candidates for `query`: whole-word matches first, then part-word matches, then every row in scope. */
  searchRecallEntries(query: string, args: RecallSearchArgs): Promise<MemoryEntry[]>;
  /** The rows of `tenantId` among the first 500 ids, ordered by created, then content, then id, all ascending; the
   * input order is ignored. */
  entriesByIds(ids: readonly string[], tenantId: TenantId): Promise<MemoryEntry[]>;
  /** The session's active goals and their policies, read together so a goal and its policy never disagree. */
  activeGoals(opts: GetActiveGoalsOpts): Promise<ActiveGoals>;
  /** The first `count` (at most 200) unsuperseded raw rows of `tenantId` that a non-empty session id and non-null
   * `origins` (those projects and user-global rows) must narrow, by created descending, then content and id ascending.
   */
  freshRawEntries(
    count: number,
    tenantId: string,
    sessionId: string | undefined,
    origins: readonly string[] | null,
  ): Promise<MemoryEntry[]>;
  /** The newest active snapshot a non-null `key` must narrow to one owner and project (null only on an unshared store),
   * then for its session the newest handoff (same key) and `eventLimit` newest events returned oldest first, each tie
   * broken by the larger id; the caller applies scope. */
  continuity(tenantId: string, eventLimit: number, key: ContinuityKey | null): Promise<ContinuityBlock>;
  /** Resolves a forward claim's tokens to one class and reads its baserate, writing no audit row. */
  planningFallacyEvidence(tenantId: string, classQueryTokens: readonly string[]): Promise<PlanningFallacyEvidence>;
  /** Appends the rows in order, all or none. */
  appendAuditEvents(events: readonly AppendAuditOpts[]): Promise<void>;
  /** Writes the goal log and audit rows in one transaction and rejects with none written if it fails. Then the trace
   * and the strengthen, each on its own: a failure there logs and still resolves, since the reply is already decided.
   */
  finishRecall(writes: RecallWrites): Promise<void>;
  /** Adds `recalled` to the one store-wide total_recalled counter, no tenant. */
  bumpRecallStats(recalled: number): Promise<void>;
  /** One token-ledger row. Throws, so the caller decides whether a ledger failure matters. */
  recordTokens(use: TokenUse): Promise<void>;
  /** Releases the store's connections; `serve()` closes only a store it made itself. */
  close(): Promise<void>;
}

/** The methods a store sets beside its groups: the `base` StoreGroup. */
export type BaseMethods = Omit<HippoStore, keyof StoreGroups | 'kind' | 'close'>;

export interface ContinuityBlock {
  activeSnapshot: TaskSnapshot | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEvent[];
}

// The groups' own request and row shapes, for the api and store-kit to name.
export type {
  ConnectorEvent,
  ConnectorWrite,
  ConnectorWriteOutcome,
  ConnectorArchive,
  ConnectorWrites,
  ConnectorEventRecord,
  DeliveryClaim,
  DeletionLookup,
  DeletionTarget,
  ArtifactArchive,
  ConnectorDeadLetter,
  ConnectorEvents,
  DeadLetterConnector,
  DeadLetterRows,
} from './port/connectors.js';

export type { RecallSearchArgs, RecallWrites } from './port/recall-writes.js';
export type { VectorReads } from './port/vector-reads.js';
export type {
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorBackfillQuery,
  VectorWrites,
} from './port/vector-writes.js';
export type { VectorViews } from './port/vector-views.js';
export type { KeyRevoke, KeyAudit } from './port/key-audit.js';
export type {
  AmbientAdmission,
  AmbientCandidateRequest,
  AmbientCandidates,
  AmbientRefusal,
  ContextReads,
} from './port/context-reads.js';
export type {
  EntryWrite,
  EntryTarget,
  OutcomeWrite,
  SupersedeWrite,
  EntryRemoval,
  RawArchive,
  EntryWrites,
} from './port/entry-writes.js';
export type { KeyMint, SelfKeyMint, KeyListQuery, KeyWrites } from './port/key-writes.js';
export type { KeyGrants } from './port/key-grants.js';
export type {
  PredictionSave,
  PredictionClose,
  PredictionFilter,
  PredictionListQuery,
  Predictions,
} from './port/predictions.js';
export type {
  ObjectListQuery,
  ObjectClose,
  ObjectSave,
  IncidentOpen,
  IncidentOpenRefusal,
  IncidentResolve,
  PoliciesInForceQuery,
  Objects,
} from './port/objects.js';
export type {
  SessionRawQuery,
  SessionRawWindow,
  SessionRawCount,
  DescendantAdmission,
  DescendantOrigin,
  DescendantPage,
  DescendantWalk,
  SummaryDescendants,
  DagReads,
} from './port/dag-reads.js';
export type { AuditLog } from './port/audit-log.js';
export type { Readiness } from './port/readiness.js';
export type { LastRecallWrites, LastRecall } from './port/last-recall.js';
export type {
  QuarantineListQuery,
  QuarantinedMemory,
  QuarantineRefusal,
  QuarantineApproval,
  QuarantineRejection,
  Quarantine,
} from './port/quarantine.js';
export type { GraphViewQuery, GraphRows, GraphReads } from './port/graph-reads.js';
export type { AuditMaintenance } from './port/audit-maintenance.js';
export type { LessonWrites } from './port/lesson-writes.js';
export type { Ledger, LedgerTurn, PilotArmOptions } from './port/ledger.js';
export type {
  EmbeddingIndex,
  IdPage,
  IdPageRequest,
  ParticleStats,
  StoredVectorSummary,
  VectorCoverage,
  VectorRow,
} from './port/embedding-index.js';
export type { PromotedCopy, Promotion } from './port/promotion.js';
export type { FolderFiles, StoreHome } from './port/folder-files.js';
export type {
  EntrySignals,
  EntryTextKey,
  EntryTextKeyPage,
  PageRequest,
  RecallSearchEntriesOptions,
  Sharing,
  SourceTally,
  TextsHoldingOptions,
} from './port/sharing.js';
