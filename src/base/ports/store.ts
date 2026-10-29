// The async store interface and its groups: every method answers a Promise and takes only data, so
// any backend can serve it from any thread, and hippo.db is one adapter. Type-only apart from the
// group probes and the store errors.
import { StoreNotPortedError } from '../util/store-blocked.js';
import type { ConnectorGroups, RecordGroups, ReviewGroups } from './store-groups.js';
import type { MemoryEntry } from '../memory/entry.js';
import type { TenantId } from '../util/tenant.js';
import type { TokenUse, Ledger } from './store/ledger.js';
import type { SessionEvent, Sessions, TaskSnapshot } from './store/sessions.js';
import type { SessionHandoff } from '../session/handoff.js';
import type { AuditMaintenance, AuditLog } from './store/audit.js';
import type { LessonWrites, EntryWrites } from './store/entry-writes.js';
import type { VectorReads, VectorWrites, EmbeddingIndex } from './store/vectors.js';
import type { KeyWrites } from './store/keys.js';
import type { ContextReads, DagReads } from './store/context-reads.js';
import type { GraphReads, GraphRebuild } from './store/graph.js';
import type { Readiness, Diagnostics } from './store/diagnostics.js';
import type { LastRecall, RecallSearchArgs, RecallWrites } from './store/recall-writes.js';
import type { Promotion, Sharing } from './store/sharing.js';
import type { FolderFiles } from './store/folder-files.js';
import type { Consolidation } from './store/consolidation.js';
import type { Learning } from './store/learning.js';
import type { Captures, CompactionHooks, Compactions } from './store/capture.js';
import type { ProjectTags } from './store/project-tags.js';
import type { AgentImport } from './store/agent-import.js';
import type { Goals } from './store/goals.js';
import type { EntryFilter, PageRequest, Reports } from './store/reports.js';
import type { Dormant } from './store/dormant.js';
import type { FailureLog } from './store/rejections.js';
export type { FolderStore, GlobalGroup, GlobalTargetGroup, StoreReach } from './store/reach.js';
import type {
  ApiKeyRecord,
  ActiveGoals,
  GetActiveGoalsOptions,
  ContinuityKey,
  EntryPage,
  PlanningFallacyEvidence,
  AppendAuditOptions,
} from './store/types.js';

/** Every group a store has: the required ones, then the optional capabilities, each a set of
 * groups a store sets or leaves unset together. `RequiredStore` is the smallest store, and
 * `runStoreConformance` from store-kit checks one. */
export interface StoreGroups extends RequiredGroups, Omit<OptionalGroups, LocalGroup> {}

/** Every capability a store may leave unset. */
interface OptionalGroups
  extends
    FallbackGroups,
    FolderGroups,
    SleepGroups,
    CaptureGroups,
    MaintenanceGroups,
    ConnectorGroups,
    RecordGroups,
    ReviewGroups {
  /** Without it drill and assemble answer 501. */
  readonly dagReads: DagReads;
  /** Without it recall expands no graph and the graph view answers 501. */
  readonly graphReads: GraphReads;
  /** The continuity, session-end and working-memory paths. */
  readonly sessions: Sessions;
  readonly goals: Goals;
  /** Status, tokens, failures and the memory listings. */
  readonly reports: Reports;
}

/** The groups hippo.db keeps in its local tier, `store.hippoDb`, off the port. Surfaces still
 * prove them by name, so StoreWith and the group probes look for each one in the tier. */
const LOCAL_GROUP_NAMES = [
  'sessions',
  'auditMaintenance',
  'connectorWrites',
  'connectorEvents',
  'rejections',
  'lastRecall',
  'reports',
  'conflicts',
  'promotion',
  'lessonWrites',
  'readiness',
  'dagReads',
  'graphReads',
  'graphRebuild',
  'ledger',
  'folderFiles',
  'sharing',
  'consolidation',
  'learning',
  'dormant',
  'captures',
  'compactionHooks',
  'compactions',
  'failureLog',
  'projectTags',
  'diagnostics',
  'agentImport',
] as const;

export type LocalGroup = (typeof LOCAL_GROUP_NAMES)[number];

export type LocalGroups = Pick<OptionalGroups, LocalGroup>;

const LOCAL_GROUPS: ReadonlySet<string> = new Set<string>(LOCAL_GROUP_NAMES);

/** The groups a store may leave unset, each with a fallback or a 501 where it is missing. */
export type OptionalGroup = keyof OptionalGroups;

/** Each optional group once, for a surface or a test to walk;
 * tests/types/store-kit.types.test.ts proves it whole. */
export const OPTIONAL_GROUPS = [
  'readiness',
  'lastRecall',
  'folderFiles',
  'sharing',
  'promotion',
  'embeddingIndex',
  'ledger',
  'consolidation',
  'learning',
  'graphRebuild',
  'lessonWrites',
  'auditMaintenance',
  'dormant',
  'captures',
  'compactionHooks',
  'compactions',
  'failureLog',
  'projectTags',
  'diagnostics',
  'agentImport',
  'connectorWrites',
  'connectorEvents',
  'objects',
  'cards',
  'conflicts',
  'rejections',
  'dagReads',
  'graphReads',
  'sessions',
  'goals',
  'reports',
] as const satisfies readonly OptionalGroup[];

/** The groups a sleep runs on: its own, and the objects and graph its graph pass reads. */
export type SleepGroup = keyof SleepGroups | 'objects' | 'graphReads';

/** Groups a store may skip for a fallback: GET /ready answers 200 with `store: "unchecked"`, and
 * context writes no last recall for the CLI's no-ids outcome to read. */
interface FallbackGroups {
  readonly readiness: Readiness;
  readonly lastRecall: LastRecall;
}

/** A store kept as files in a folder; without these, init, share, sync down and promote answer
 * 501. */
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

/** Sleep's reads and writes, git learn's batch and the dormant rows sleep keeps; without them,
 * sleep and consolidate answer 501. */
export interface SleepGroups {
  /** Over every tenant. */
  readonly consolidation: Consolidation;
  /** The learn passes. */
  readonly learning: Learning;
  readonly graphRebuild: GraphRebuild;
  readonly lessonWrites: LessonWrites;
  /** The audit pass's deletes and repairs, and the audit log's prune. */
  readonly auditMaintenance: AuditMaintenance;
  readonly dormant: Dormant;
}

/** `hippo capture`, the compaction hooks and the failure log, which a store without them
 * refuses. */
export interface CaptureGroups {
  /** Capture's writes and its dedup read. */
  readonly captures: Captures;
  /** The compaction hooks' records and their replay. */
  readonly compactionHooks: CompactionHooks;
  /** The compaction records a caller's hook starts and fills. */
  readonly compactions: Compactions;
  readonly failureLog: FailureLog;
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

/** What remember, recall and context write and read, the vectors recall ranks by, and the key
 * writes auth makes: every store sets these whole. */
interface RequiredGroups {
  readonly keyWrites: KeyWrites;
  readonly entryWrites: EntryWrites;
  readonly contextReads: ContextReads;
  readonly auditLog: AuditLog;
  readonly vectors: VectorReads;
  /** embedMemory and embedAll write through it. */
  readonly vectorWrites: VectorWrites;
}

/** A store a sleep can run on. */
export type SleepStore = StoreWith<SleepGroup>;

export type StoreGroup = 'base' | keyof GroupMethods;

/** True when the store sets `group`; for an optional group the store is narrowed to one that
 * does. */
export function hasGroup<G extends OptionalGroup>(
  store: HippoStore,
  group: G,
): store is StoreWith<G>;
export function hasGroup(store: HippoStore, group: StoreGroup): boolean;
export function hasGroup(store: HippoStore, group: StoreGroup): boolean {
  return group === 'base' || groupOf(store, group) !== undefined;
}

/** The optional group's methods; a store without them throws
 * StoreNotPortedError, which answers 501 as any unported path does. */
export function requireGroup<G extends OptionalGroup>(
  store: HippoStore,
  group: G,
): GroupMethods[G] {
  const methods = groupOf(store, group);
  if (methods === undefined) throw new StoreNotPortedError(store.kind, group);
  return methods;
}

/** Every optional group's methods, wherever the store keeps them. */
type GroupMethods = StoreGroups & LocalGroups;

/** `group`'s methods as `store` set them: a local group's in its tier, any other's on the store
 * itself, which HippoStore names only for the required groups. */
function groupOf<G extends keyof GroupMethods>(
  store: HippoStore,
  group: G,
): Partial<GroupMethods>[G] {
  const own: Partial<GroupMethods> & { readonly hippoDb?: Partial<LocalGroups> } = store;
  const holder: Partial<GroupMethods> = LOCAL_GROUPS.has(group) ? (own.hippoDb ?? {}) : own;
  return holder[group];
}

/** True when the store sets every group `needs` names; a surface asks once, as it binds a verb,
 * never per request. */
export function hasGroups<G extends OptionalGroup>(
  store: HippoStore,
  needs: readonly G[],
): store is StoreWith<G> {
  return needs.every((group) => groupOf(store, group) !== undefined);
}

/** `store` narrowed to every group `needs` names; a store without one throws StoreNotPortedError
 * naming the first. */
export function requireGroups<G extends OptionalGroup>(
  store: HippoStore,
  needs: readonly G[],
): StoreWith<G> {
  if (hasGroups(store, needs)) return store;
  const missing = needs.find((group) => groupOf(store, group) === undefined);
  throw new StoreNotPortedError(store.kind, missing ?? needs.join(', '));
}

/** The smallest store: every required group and base method, none of the optional groups. */
export type RequiredStore = Omit<HippoStore, OptionalGroup>;

/** A store that sets the optional groups `G`, as a surface proves once before it calls in; `F`
 * are the groups a feature reads where it states its fallback, so they may be unset. */
export type StoreWith<G extends OptionalGroup, F extends OptionalGroup = never> = RequiredStore &
  Pick<StoreGroups, Extract<G, keyof StoreGroups>> &
  Partial<Pick<StoreGroups, Extract<F, keyof StoreGroups>>> &
  TierWith<Extract<G, LocalGroup>, Extract<F, LocalGroup>>;

/** The local tier StoreWith asks for: `G`'s groups set, `F`'s perhaps; nothing when both are
 * empty, so a store with no tier still meets a StoreWith of port groups alone. */
type TierWith<G extends LocalGroup, F extends LocalGroup> = ([G] extends [never]
  ? unknown
  : { readonly hippoDb: Pick<LocalGroups, G> }) &
  ([F] extends [never] ? unknown : { readonly hippoDb?: Partial<Pick<LocalGroups, F>> });

export { isStoreBusy, STORE_BUSY_MESSAGE, StoreBusyError } from '../util/store-blocked.js';

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an
 * await, since a lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore extends RequiredGroups {
  /** A name for logs and errors. */
  readonly kind: string;
  /** The API key record for `keyId` with its scope grants, revoked or not; null when none
   * matches. */
  findApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** Recall candidates for `query`: whole-word matches first, then part-word matches, then every
   * row in scope. */
  searchRecallEntries(query: string, args: RecallSearchArgs): Promise<MemoryEntry[]>;
  /** The rows of `tenantId` among `ids`, any number of them, ordered by created, then content,
   * then id, all ascending; the input order is ignored. */
  entriesByIds(ids: readonly string[], tenantId: TenantId): Promise<MemoryEntry[]>;
  /** A page of the rows `filter` keeps, by created then id; ALL_TENANTS pages every tenant (host
   * admin, the api checks). One read for each walk of a filtered set of rows, so no group keeps
   * a read per caller. */
  entriesWhere(filter: EntryFilter, page: PageRequest): Promise<EntryPage>;
  /** The session's active goals and their policies, read together so a goal and its policy never
   * disagree. */
  activeGoals(opts: GetActiveGoalsOptions): Promise<ActiveGoals>;
  /** The first `count` (at most MAX_FRESH_RAW) unsuperseded raw rows of `tenantId` that a non-empty
   * session id and non-null `origins` (those projects and user-global rows) must narrow, by created
   * descending, then content and id ascending.
   */
  freshRawEntries(
    count: number,
    tenantId: string,
    sessionId: string | undefined,
    origins: readonly string[] | null,
  ): Promise<MemoryEntry[]>;
  /** The newest active snapshot a non-null `key` must narrow to one owner and project (null only
   * on an unshared store), then for its session the newest handoff (same key) and `eventLimit`
   * newest events returned oldest first, each tie broken by the larger id; the caller applies
   * scope. */
  continuity(
    tenantId: string,
    eventLimit: number,
    key: ContinuityKey | null,
  ): Promise<ContinuityBlock>;
  /** Resolves a forward claim's tokens to one class and reads its baserate, writing no audit
   * row. */
  planningFallacyEvidence(
    tenantId: string,
    classQueryTokens: readonly string[],
  ): Promise<PlanningFallacyEvidence>;
  /** Appends the rows in order, all or none. */
  appendAuditEvents(events: readonly AppendAuditOptions[]): Promise<void>;
  /** Writes the goal log and audit rows in one transaction and rejects with none written if it
   * fails. Then the trace and the strengthen, each on its own: a failure there logs and still
   * resolves, since the reply is already decided.
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
  ConnectorDeadLetter,
  ConnectorEvents,
  DeadLetterConnector,
  DeadLetterRows,
} from './store/connectors.js';

export type {
  RecallSearchArgs,
  RecallWrites,
  LastRecallWrites,
  LastRecall,
} from './store/recall-writes.js';
export type {
  VectorReads,
  StoredPart,
  StoredParts,
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorBackfillQuery,
  VectorWrites,
  EmbeddingIndex,
  IndexSession,
  IndexStep,
  IndexStepAnswers,
  IndexStepKind,
  IdPage,
  IdPageRequest,
  StoredVectorSummary,
  VectorCoverage,
  VectorRow,
} from './store/vectors.js';
export type { KeyRevoke, KeyMint, SelfKeyMint, KeyListQuery, KeyWrites } from './store/keys.js';
export type {
  AmbientAdmission,
  AmbientCandidateRequest,
  AmbientCandidates,
  AmbientRefusal,
  ContextReads,
  SessionRawQuery,
  SessionRawCount,
  DescendantAdmission,
  DescendantOrigin,
  DescendantPage,
  DescendantWalk,
  SummaryDescendants,
  DagReads,
} from './store/context-reads.js';
export type {
  EntryWrite,
  EntryTarget,
  OutcomeWrite,
  SupersedeWrite,
  EntryRemoval,
  RawArchive,
  EntryWrites,
  LessonWrites,
} from './store/entry-writes.js';
export type {
  PredictionSave,
  PredictionClose,
  PredictionFilter,
  PredictionListQuery,
  ObjectListQuery,
  ObjectClose,
  ObjectSave,
  IncidentOpen,
  IncidentOpenRefusal,
  IncidentResolve,
  PoliciesInForceQuery,
  SkillsByNameQuery,
  Objects,
} from './store/objects.js';
export type { AuditLog, AuditMaintenance } from './store/audit.js';
export type { Readiness } from './store/diagnostics.js';
export type { GraphViewQuery, GraphWalkQuery, GraphRows, GraphReads } from './store/graph.js';
export type { Ledger, LedgerTurn, PilotArmOptions } from './store/ledger.js';
export type {
  PromotedCopy,
  Promotion,
  EntrySignals,
  EntryTextKey,
  EntryTextKeyPage,
  RecallSearchEntriesOptions,
  Sharing,
  SourceTally,
} from './store/sharing.js';
export type { EntryFilter, PageRequest } from './store/reports.js';
export type { TextsHoldingOptions } from './store/capture.js';
export type { FolderFiles, StoreHome } from './store/folder-files.js';

// Value exports of the effect tables, kept in a port file of their own.
export { BASE_EFFECTS, STORE_EFFECTS } from './store/store-effects.js';
