// The async store interface and its groups; type-only apart from
// the store errors, so an add-on can build a store on it alone.
import { StoreNotPortedError } from '../util/sqlite-blocked.js';
import type { LocalFiles } from './port/local-files.js';
import type { SessionAndAdminGroups } from './port-groups.js';
import type { MemoryEntry } from '../core/memory.js';
import type { TokenUse } from './port/token-ledger.js';
import type { SessionEvent, TaskSnapshot } from './port/sessions.js';
import type { SessionHandoff } from '../core/handoff.js';
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
import type {
  ApiKeyRecord,
  ActiveGoals,
  GetActiveGoalsOpts,
  ContinuityKey,
  PlanningFallacyEvidence,
  AppendAuditOpts,
} from './port/types.js';
export type {
  ConnectorEvent,
  ConnectorWrite,
  ConnectorWriteOutcome,
  ConnectorArchive,
  ConnectorWrites,
  ConnectorEventRecord,
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

export type {
  AgentImport,
  Captures,
  CompactionHooks,
  Consolidation,
  ContainerTx,
  EmbeddingIndex,
  FolderFiles,
  ImportTarget,
  Ledger,
  LocalFiles,
} from './port/local-files.js';

/** Every group a store sets whole; only the four in OptionalGroup may be left unset. */
export interface StoreGroups extends SessionAndAdminGroups {
  /** Unset on any store but hippo.db; a request then runs fenced from
   * hippo.db, and a route or tool that names `localFiles` answers 501. */
  readonly localFiles: LocalFiles;
  readonly auditMaintenance: AuditMaintenance;
  readonly lessonWrites: LessonWrites;
  readonly vectors: VectorReads;
  /** Unset on a store without them, where recall scores the number[] copies `vectors` returns, to the same ranking. */
  readonly vectorViews: VectorViews;
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
  /** Unset on a store built before it, where GET /ready answers 200 with `store: "unchecked"`. */
  readonly readiness: Readiness;
  /** Unset on a store that keeps no last recall, where an outcome with no ids answers 501 and context writes no last
   * recall. */
  readonly lastRecall: LastRecall;
}

/** The groups a store may leave unset, each with a fallback or a 501 where it is missing. */
export type OptionalGroup = 'localFiles' | 'vectorViews' | 'readiness' | 'lastRecall';

export type StoreGroup = 'base' | keyof StoreGroups;

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

/** hippo.db and the folder it sits in, for work that reads both: sharing, sync, embedding and the global store. */
export interface FolderStore {
  readonly root: string;
  readonly store: StoreWith<'localFiles'>;
}

function setsGroup<G extends OptionalGroup>(store: HippoStore, group: G): store is StoreWith<G> {
  return store[group] !== undefined;
}

/** `store` typed with `group` set; a store without it throws StoreNotPortedError, which answers 501. */
export function storeWith<G extends OptionalGroup>(store: HippoStore, group: G): StoreWith<G> {
  if (!setsGroup(store, group)) throw new StoreNotPortedError(store.kind, group);
  return store;
}

/** Which stores a call reaches, probed once by a composition root so the api reads this instead of the disk. */
export interface StoreReach {
  readonly hasLocal: boolean; // the primary store has a project of its own, or is not hippo.db
  readonly isGlobal: boolean; // the primary root is the operator's global store
  readonly shared: boolean; // a store serving many people, so the operator's global store stays out
  readonly global?: { readonly root: string; readonly store: HippoStore }; // set only when readable
  readonly isHippoDb?: boolean; // the primary store is hippo.db, whose folder `hippo embed` and sleep reach
  readonly globalTarget?: FolderStore; // where share, promote and sync write; set on hippo.db, maybe not created yet
}

export { isStoreBusy, STORE_BUSY_MESSAGE, StoreBusyError } from './port/busy.js';

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an
 * await, since SQLite's lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore extends Omit<StoreGroups, OptionalGroup>, Partial<Pick<StoreGroups, OptionalGroup>> {
  /** A name for logs and errors; what a store can do beyond the required groups is the optional ones it sets. */
  readonly kind: string;
  /** The api_keys row for `keyId` with its scope grants, revoked or not; null when no row matches. */
  findApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** Recall candidates in `loadRecallEntriesAt` order: FTS, then LIKE, then every row in scope. */
  searchRecallEntries(query: string, args: RecallSearchArgs): Promise<MemoryEntry[]>;
  /** The rows among the first 500 ids, a tenant narrowing them, ordered by created, then content, then id, all
   * ascending, as `loadEntriesByIds` does; the input order is ignored. */
  entriesByIds(ids: readonly string[], tenantId?: string): Promise<MemoryEntry[]>;
  /** The session's active goals and their policies, read together so a goal and its policy never disagree. */
  activeGoals(opts: GetActiveGoalsOpts): Promise<ActiveGoals>;
  /** The first `count` (at most 200) unsuperseded raw rows a tenant, a non-empty session
   * id and non-null `origins` (those projects and user-global rows) must narrow, by
   * created descending, then content and id ascending, as `loadFreshRawMemories` does. */
  freshRawEntries(
    count: number,
    tenantId: string | undefined,
    sessionId: string | undefined,
    origins: readonly string[] | null,
  ): Promise<MemoryEntry[]>;
  /** The newest active snapshot a non-null `key` must narrow to one owner and project (null only on an unshared
   * hippo.db), then for its session the newest handoff (same key) and `eventLimit` newest events returned oldest first,
   * each tie broken by the larger id; the caller applies scope. */
  continuity(tenantId: string, eventLimit: number, key: ContinuityKey | null): Promise<ContinuityBlock>;
  /** Resolves a forward claim's tokens to one class and reads its baserate, writing no audit row. */
  planningFallacyEvidence(tenantId: string, classQueryTokens: readonly string[]): Promise<PlanningFallacyEvidence>;
  /** Appends the rows in order, all or none. */
  appendAuditEvents(events: readonly AppendAuditOpts[]): Promise<void>;
  /** Writes the goal log and audit rows in one transaction and rejects with none
   * written if it fails. Then the trace and the strengthen, each on its own: a
   * failure there logs and still resolves, since the reply is already decided. */
  finishRecall(writes: RecallWrites): Promise<void>;
  /** Adds `recalled` to the one store-wide total_recalled counter,
   * no tenant; the SQLite store also rewrites stats.json. */
  bumpRecallStats(recalled: number): Promise<void>;
  /** One token-ledger row. Throws, so the caller decides whether a ledger failure matters. */
  recordTokens(use: TokenUse): Promise<void>;
  /** Releases the store's connections; `serve()` closes only a store it made itself. */
  close(): Promise<void>;
}

/** `T` with each method answering its value instead of a Promise of it, groups included: the port as a synchronous
 * store has it. */
export type Sync<T> = T extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => R
  : T extends (...args: never) => void
    ? T
    : T extends object
      ? { [K in keyof T]: Sync<T[K]> }
      : T;

export interface ContinuityBlock {
  activeSnapshot: TaskSnapshot | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEvent[];
}
