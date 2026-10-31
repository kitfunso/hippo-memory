// The async store interface: every method answers a Promise and takes only data, so any backend can
// serve it from any thread, and hippo.db is one adapter. Type-only apart from the store errors.
import type { MemoryEntry } from '../memory/entry.js';
import type { TenantId } from '../util/tenant.js';
import type { TokenUse } from '../records/ledger.js';
import type { SessionEvent, TaskSnapshot } from '../records/sessions.js';
import type { SessionHandoff } from '../session/handoff.js';
import type { AuditLog } from './store/audit.js';
import type { EntryWrites } from './store/entry-writes.js';
import type { VectorReads, VectorWrites } from './store/vectors.js';
import type { KeyWrites } from './store/keys.js';
import type { ContextReads } from './store/context-reads.js';
import type { RecallSearchArgs, RecallWrites } from './store/recall-writes.js';
import type { EntryFilter, PageRequest } from '../records/reports.js';
export type { FolderStore, StoreReach } from './store/reach.js';
import type {
  ApiKeyRecord,
  ActiveGoals,
  GetActiveGoalsOptions,
  ContinuityKey,
  EntryPage,
  PlanningFallacyEvidence,
  AppendAuditOptions,
} from './store/types.js';

/** What remember, recall and context write and read, the vectors recall ranks by, and the key
 * writes auth makes: every store sets these whole. */
export interface CoreGroups {
  readonly keyWrites: KeyWrites;
  readonly entryWrites: EntryWrites;
  readonly contextReads: ContextReads;
  readonly auditLog: AuditLog;
  readonly vectors: VectorReads;
  /** embedMemory and embedAll write through it. */
  readonly vectorWrites: VectorWrites;
}

export { isStoreBusy, STORE_BUSY_MESSAGE, StoreBusyError } from '../util/store-blocked.js';

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an
 * await, since a lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore extends CoreGroups {
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

/** The methods a store sets beside its groups. */
export type BaseMethods = Omit<HippoStore, keyof CoreGroups | 'kind' | 'close'>;

export interface ContinuityBlock {
  activeSnapshot: TaskSnapshot | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEvent[];
}

// The groups' own request and row shapes, for the api and store-kit to name.

export type { RecallSearchArgs, RecallWrites } from './store/recall-writes.js';
export type {
  VectorReads,
  StoredPart,
  StoredParts,
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorBackfillQuery,
  VectorWrites,
} from './store/vectors.js';
export type { KeyRevoke, KeyMint, SelfKeyMint, KeyListQuery, KeyWrites } from './store/keys.js';
export type {
  AmbientAdmission,
  AmbientCandidateRequest,
  AmbientCandidates,
  AmbientRefusal,
  ContextReads,
  DescendantOrigin,
} from './store/context-reads.js';
export type {
  EntryWrite,
  EntryTarget,
  OutcomeWrite,
  SupersedeWrite,
  EntryRemoval,
  RawArchive,
  EntryWrites,
} from './store/entry-writes.js';
export type { AuditLog } from './store/audit.js';

// Value exports of the effect tables, kept in a port file of their own.
export { BASE_EFFECTS, STORE_EFFECTS } from './store/store-effects.js';
