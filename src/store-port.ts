// The async seam the server reaches its store through, so an add-on can serve from a database other than hippo.db.
import type { AmbientTallies } from './ambient.js';
import { loadAmbientTallies, type AmbientStoreFilter } from './ambient-store.js';
import { listApiKeyRows, readApiKeyRecord, type ApiKeyListRow, type ApiKeyRecord, type ListApiKeysOpts, type NewApiKey } from './auth.js';
import { appendAuditEvent, listAuditEventsAfter, type AppendAuditOpts, type AuditEvent, type ListAuditAfterOpts } from './audit.js';
import type { ContinuityBlock } from './api/recall-types.js';
import type { CompactionRecord } from './compaction-record.js';
import { withWriteScope } from './db.js';
import { StoreNotPortedError } from './db/sqlite-blocked.js';
import { embeddingIndexStateAt, loadStoredVectors, type EmbeddingIndexState } from './embeddings.js';
import type { FailureEvent, LoggedFailure } from './failure-log.js';
import {
  activeGoalsWithPolicies, localGoalRecallRows, writeGoalRecallLog,
  type ActiveGoals, type GetActiveGoalsOpts, type GoalRecallLogRow,
} from './goals.js';
import type { SessionHandoff } from './handoff.js';
import type { JsonValue } from './json.js';
import type { MemoryEntry } from './memory.js';
import type { PhysicsParticle } from './physics.js';
import { loadPhysicsState } from './physics-state.js';
import type { PilotArm } from './pilot-arm.js';
import { planningFallacyEvidenceAt, type PlanningFallacyEvidence } from './predictions/planning-fallacy.js';
import { writeRecallTrace, type RecallTraceInput } from './recall-trace.js';
import {
  loadAmbientCandidates, loadContextCandidates,
  type AmbientLoadResult, type AmbientRecallRequest, type ContextCandidateFilter, type HeldText, type RecentOrigins,
} from './store/candidates.js';
import { loadEntriesByIds, loadFreshRawMemories } from './store/entry-reads.js';
import { auditHighIdAt, revokeKeyAt } from './store/key-audit.js';
import { createKeyAt, createSelfKeyAt } from './store/key-writes.js';
import { strengthenRetrievedInOwnTx, type StrengthenOptions } from './store/entry-writes.js';
import { sqliteEntryWrites } from './store/entry-writes-group.js';
import { loadLatestHandoff } from './store/handoffs.js';
import { sqliteHookStore } from './store/hooks-group.js';
import { updateStats } from './store/index-and-stats.js';
import { onHandle } from './store/open.js';
import type { TaskSnapshot } from './store/rows.js';
import { loadRecallSearchEntries, loadVectorCandidateEntries, type OriginFilter, type VectorCandidateSpec } from './store/search-rows.js';
import { type ContinuityKey, listSessionEvents, loadActiveTaskSnapshot, type TaskSnapshotInput } from './store/sessions.js';
import { entriesWithoutVectorAt, writeVectorsAt } from './store/vector-writes.js';
import { recordTokenUse, type LastSent, type TokenSurface, type TokenUse } from './token-ledger.js';

/** The arguments of `loadRecallSearchEntries` after the query, by name. */
export interface RecallSearchArgs {
  readonly limit: number;
  readonly tenantId?: string;
  readonly requestedScope?: string;
  readonly explicitScopeMode: 'exact' | 'additive';
  readonly includeSuperseded: boolean;
  readonly originProjects?: OriginFilter;
  /** The caller's personal scope, which the default deny admits; undefined admits no personal row. */
  readonly ownScope: string | undefined;
}

/** Everything one recall writes once its reply is decided, so a store writes it on one connection. */
export interface RecallWrites {
  /** Insert or ignore on (memory_id, goal_id), so the first row wins, a duplicate inside this batch included. First drop a row
   *  whose memory_id is in no memories row of this store, whatever that row's tenant, as `localGoalRecallRows` does. */
  readonly goalLog: readonly GoalRecallLogRow[];
  /** In the order they happened. */
  readonly audit: readonly AppendAuditOpts[];
  readonly trace?: RecallTraceInput;
  /** Nothing when `recallBoostAblated`. Each id found, in `tenantId` when set, gets the retrieval_count, last_retrieved,
   *  half_life_days and strength `markRetrieved` computes from the row read before any update, so a repeated id moves once. */
  readonly strengthen?: { readonly ids: readonly string[]; readonly opts: StrengthenOptions };
}

/** The reads behind recall's vector arm. */
export interface VectorReads {
  /** The stored model and whether any vector exists, in one snapshot. */
  embeddingIndexState(): Promise<EmbeddingIndexState>;
  storedVectors(ids: readonly string[]): Promise<Map<string, number[]>>;
  /** The `spec.limit ?? 50` rows nearest `queryVector` by `rankVectorRows` among those where the tenant matches (when set), kind is not 'archived', a superseded row
   *  shows only with `includeSuperseded`, scope follows `RecallScopeFilter`, and origin is '' or listed (when `spec.origin` is set). */
  nearestEntries(queryVector: readonly number[], spec: VectorCandidateSpec): Promise<MemoryEntry[]>;
  /** The particles of `ids` only; an empty list reads nothing. */
  physicsParticles(ids: readonly string[]): Promise<Map<string, PhysicsParticle>>;
}

/** One memory's vector, computed by the caller's embedding provider. */
export interface VectorRowWrite {
  readonly memoryId: string;
  readonly vector: readonly number[];
  /** Kept only when the memory has no particle yet, under `memoryId` whatever its own memoryId says. */
  readonly particle?: PhysicsParticle;
}

export interface VectorWrite {
  readonly tenantId: string;
  /** The index identity the vectors were built by, `embeddingIndexIdentity(provider.id)`. */
  readonly model: string;
  /** Set only by embedAll's rebuild, so a write that read the index state before another process rebuilt it cannot drop that rebuild. */
  readonly replaceIndex: boolean;
  readonly rows: readonly VectorRowWrite[];
}

export interface VectorWriteResult {
  readonly written: number;
  /** True when another model built the index and `replaceIndex` is false; the store then keeps nothing and `written` is 0. */
  readonly modelMismatch: boolean;
}

export interface VectorBackfillQuery {
  readonly model: string;
  /** Only ids above this one in byte order; unset starts at the first. */
  readonly afterId?: string;
  /** Clamped to 1..500; a non-integer rejects with RangeError `limit must be an integer`. */
  readonly limit: number;
  /** Every tenant when unset, since the backfill covers the whole store. */
  readonly tenantId?: string;
}

/** The writes behind embed on write and the backfill: core computes each vector, the store only keeps it.
 *  A store deletes a memory's vector and particle when the memory is deleted (hippo.db does it by trigger and foreign-key cascade). */
export interface VectorWrites {
  /** Memories of any kind with no vector stored under `query.model`, by id ascending in byte order. */
  entriesWithoutVector(query: VectorBackfillQuery): Promise<MemoryEntry[]>;
  /** In one transaction: refuses with `modelMismatch` if `replacesIndex` and not `replaceIndex`; else, when a row is writable (memory in `tenantId`, vector non-empty
   *  and finite), drops every vector and particle if `replacesIndex`, keeps each writable row under `model` with its particle where none exists, sets `model`. No audit row. */
  writeVectors(write: VectorWrite): Promise<VectorWriteResult>;
}

export interface KeyRevoke {
  readonly tenantId: string;
  readonly keyId: string;
  readonly actor: string;
  readonly at: string;
}

export interface KeyAudit {
  /** Sets revoked_at to `at` and appends one auth_revoke row (the key's tenant, `actor`, the key id) in one transaction, then resolves to `at`. A revoked
   *  key resolves to its own revoked_at and writes nothing; a key missing from `tenantId` rejects with NotFoundError `Unknown key_id: <keyId>`. */
  revokeApiKey(revoke: KeyRevoke): Promise<string>;
  /** As `listAuditEventsAfter`: rows above `afterId` in ascending id order, with its RangeErrors, limit clamp and tenant filter. */
  auditEventsAfter(opts: ListAuditAfterOpts): Promise<AuditEvent[]>;
  /** The highest audit id ever assigned, pruned rows included, 0 before the first; a tail that sees it drop knows the log was restored. */
  auditHighId(): Promise<number>;
}

/** One ambient load: the pins, the `recentNeeded` newest rows `admit` keeps, and the prompt-recall candidates. */
export interface AmbientCandidateRequest {
  readonly recentNeeded: number;
  /** Sees each row in the order `loadAmbientCandidates` reads them, since the delivery ledger counts its refusals. */
  readonly admit: (e: MemoryEntry) => boolean;
  readonly recall?: AmbientRecallRequest;
  readonly origins?: RecentOrigins;
}

/** The reads behind getContext beyond the base `continuity`: its fallback handoff, candidate rows and ambient tallies.
 *  getContext with a query under an embedding provider needs `vectors` too, and answers 501 without it. */
export interface ContextReads {
  /** The newest handoff of the last `maxAgeMs` that is its session's highest id, has no outcome or a partial or failed one, and
   *  passes recall's default scope deny, as `loadLatestHandoff` with `unfinishedOnly` and `scopeFilter: 'default-deny'`. Rejects an empty tenant id. */
  unfinishedHandoff(tenantId: string, maxAgeMs: number, key: ContinuityKey | null): Promise<SessionHandoff | null>;
  /** As `loadAmbientCandidates`; `recall` searches with the query `rarestFtsQuery` builds from FTS document counts over every tenant's rows,
   *  and finds nothing when no term is indexed. Core keeps only `tenantId`'s rows that its own admit passes, whatever the store returns. */
  ambientCandidates(tenantId: string, request: AmbientCandidateRequest): Promise<AmbientLoadResult>;
  /** As `loadContextCandidates`: at most `filter.cap` live rows, pins and then the least decayed first, returned by created, then id. */
  contextCandidates(tenantId: string, filter: ContextCandidateFilter): Promise<MemoryEntry[]>;
  /** As `loadAmbientTallies`: one aggregate over the live, unarchived rows `filter` admits, less other projects' secret-tagged rows. */
  ambientTallies(tenantId: string, filter: AmbientStoreFilter): Promise<AmbientTallies>;
}

export interface EntryWrite {
  readonly entry: MemoryEntry;
  readonly actor: string;
}

/** Who acts on which of a tenant's rows; `ownScope` is the caller's personal scope, so every other personal row is out of reach. */
export interface EntryTarget {
  readonly tenantId: string;
  readonly actor: string;
  readonly ownScope: string | null;
}

export interface OutcomeWrite extends EntryTarget {
  readonly ids: readonly string[];
  readonly good: boolean;
}

export interface SupersedeWrite extends EntryTarget {
  readonly oldId: string;
  readonly successor: MemoryEntry;
}

export interface EntryRemoval extends EntryTarget {
  readonly id: string;
}

export interface RawArchive extends EntryRemoval {
  readonly reason: string;
}

/** The memory-row writes behind remember, outcome, supersede, archive and forget. Each writes its audit rows in the write's own transaction,
 *  a child row's change marks its level 2 or 3 summary parent dirty (one summary_marked_dirty row on the flip), and the schema's rules hold. */
export interface EntryWrites {
  /** Upserts the row, its full-text row and one remember row ({kind, scope}) in the entry's tenant; an id another tenant holds rejects in the transaction with ConflictError `Memory <id>
   *  belongs to another tenant`. Content the write brings into a tenant that tombstoned it rejects with RejectedValueError and writes one reject_refusal row after the rollback, best effort. */
  writeEntry(write: EntryWrite): Promise<void>;
  /** For each id in order, a row of the tenant within reach gets `entryAfterOutcome`, a rewrite as writeEntry does and one outcome row ({good}); other ids are skipped, a repeated id builds
   *  on its first outcome. Each read holds the row's lock to commit (SELECT ... FOR UPDATE), so a supersede between read and rewrite is not undone. Resolves to the ids applied, repeats kept. */
  applyOutcome(outcome: OutcomeWrite): Promise<string[]>;
  /** Sets the old row's superseded_by where it is within reach and not yet superseded, both checked in the transaction, else rejects with NotFoundError `memory not found: <oldId>` or
   *  ConflictError `Memory <oldId> already superseded by another writer`. Then writes the successor as writeEntry does and one supersede row ({newId}), all or nothing. */
  supersede(write: SupersedeWrite): Promise<void>;
  /** Moves a raw row to raw_archive (metadata only, no content), deletes it and its full-text row and writes one archive_raw row ({reason});
   *  resolves to the archived_at written. A row out of reach rejects with NotFoundError `memory not found: <id>`, any other kind with BadRequestError. */
  archiveRaw(archive: RawArchive): Promise<string>;
  /** Deletes the row and its full-text row and writes one forget row; a raw row rejects, being append-only. A row out of reach rejects with
   *  NotFoundError `memory not found: <id>`. Archive and forget then add one to the store-wide forgotten counter, best effort. */
  forget(removal: EntryRemoval): Promise<void>;
}

/** A key to insert and the actor and metadata of its auth_create row, whose tenant and target are the key's. Neither holds the plaintext. */
export interface KeyMint {
  readonly key: NewApiKey;
  readonly actor: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SelfKeyMint extends KeyMint {
  readonly key: NewApiKey & { readonly ownerSubject: string; readonly expiresAt: string };
  /** Live keys the owner may hold in the tenant once this one is in. */
  readonly perSubject: number;
}

/** `listApiKeyRows`'s filters, always inside one tenant. */
export interface KeyListQuery extends Omit<ListApiKeysOpts, 'tenantId'> {
  readonly tenantId: string;
}

export interface KeyWrites {
  /** Inserts the key and appends its auth_create row in one transaction; with either one failing, neither is written. A key id taken in any tenant
   *  rejects, since keys are looked up by id alone. */
  createApiKey(mint: KeyMint): Promise<void>;
  /** One transaction, serialized per (tenant, owner) before the count (hippo.db BEGIN IMMEDIATE, Postgres pg_advisory_xact_lock on the pair): revoke at `key.createdAt`
   *  the owner's oldest live keys in the key's tenant down to `perSubject - 1`, insert the key, append an auth_revoke row `{ replacedBy: <new key id> }` per revoked key,
   *  then the auth_create row; resolves to the revoked ids. Live: unrevoked, expires_at null or Date.parse(expires_at) after createdAt (NaN counts as expired). */
  createSelfApiKey(mint: SelfKeyMint): Promise<string[]>;
  /** As `listApiKeyRows`: newest inserted first, each with its scope grants; `active` drops revoked rows and an expires_at not above now's toISOString. */
  listApiKeys(query: KeyListQuery): Promise<ApiKeyListRow[]>;
}

export interface SessionBinding {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly owner: string;
}

export interface PilotArmBooking {
  readonly arm: PilotArm;
  readonly rateBp: number;
}

/** The team-visible rows (`scopeAdmitSql('')`), or every row the caller may touch (`touchableScopeSql('', ownScope)`). */
export type HeldTextReach = { readonly kind: 'team' } | { readonly kind: 'touchable'; readonly ownScope: string | null };

export interface HeldTextQuery {
  readonly tenantId: string;
  readonly words: readonly string[];
  /** Only rows carrying one of these origin names, and user-global rows; unset reads every origin. */
  readonly project?: readonly string[];
  readonly reach: HeldTextReach;
}

export interface SessionEndState {
  readonly activeSnapshot: TaskSnapshot | null;
  readonly latestHandoff: SessionHandoff | null;
  /** The content of the session's newest session_complete event, unchecked. */
  readonly completedWith: string | null;
}

export interface SessionEnd {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly key: ContinuityKey;
  /** Called once with the state read; null writes no handoff. */
  readonly plan: (state: SessionEndState) => Omit<SessionHandoff, 'updatedAt'> | null;
}

export interface SessionEndWrite {
  readonly handoff: SessionHandoff | null;
  readonly snapshotsClosed: number;
}

/** cwd and transcript_path stay null, as a caller sends neither. */
export interface CompactionOpen {
  readonly tenantId: string;
  readonly id: string;
  readonly sessionId: string;
  readonly originProject: string;
  readonly trigger: string | null;
  readonly startedAt: string;
  readonly snapshotSaved: boolean;
}

export interface CompactionSummary {
  readonly tenantId: string;
  /** The id a new record takes when no started one is found. */
  readonly id: string;
  readonly sessionId: string;
  readonly trigger: string | null;
  readonly originProject: string;
  readonly requestId: string;
  readonly summary: string;
  readonly items: readonly string[];
  /** When the compaction ended; the started record searched for lies within REPLAY_AFTER_MS before it. */
  readonly at: string;
}

export interface HeldItem {
  readonly id: string;
  readonly sessionId: string | null;
  readonly content: string;
}

export interface RejectedValueMark {
  readonly reason: string | null;
  readonly rejectedAt: string;
}

/** An item a tombstone refused, which gets one reject_refusal row ({digest, reason}) under the write's tenant and actor. */
export interface RefusedItem {
  readonly entryId: string;
  readonly digest: string;
  readonly reason: string | null;
}

/** A row to write as writeEntry does, or a refused item's audit row in its place. */
export type CompactionItemStep = { readonly write: MemoryEntry } | { readonly refuse: RefusedItem };

export interface CompactionItemPlan {
  readonly steps: readonly CompactionItemStep[];
  readonly restated: readonly string[];
}

export interface CompactionItemsWrite {
  readonly tenantId: string;
  readonly recordId: string;
  readonly actor: string;
  readonly origins: readonly string[];
  /** The `rejectionDigest`s whose tombstones the plan needs. */
  readonly digests: readonly string[];
  readonly strengthen: StrengthenOptions;
  /** Called once inside the transaction, so no other writer lands between the read and the writes. */
  readonly plan: (held: readonly HeldItem[], tombstones: ReadonlyMap<string, RejectedValueMark>) => CompactionItemPlan;
}

export interface CompactionItemsResult {
  readonly written: number;
  /** The record had left `summarised` before this call, so nothing was planned and `written` is its stored count. */
  readonly alreadyDone: boolean;
}

export interface CallerFailureLog extends FailureEvent {
  readonly requestId: string;
}

/** The reads and writes behind the hook routes. captureSessionTexts, captureFailureForCaller and hippo_learn need `entryWrites` too, and promptHookContext
 *  `contextReads`; token rows go through the base `recordTokens`, task state reads through the base `continuity`. */
export interface HookStore {
  /** The session's stored owner, after binding `owner` when none is stored and pruning bindings past 90 days. No audit row. */
  bindSession(binding: SessionBinding): Promise<string | null>;
  /** The session's first pilot/arm token row in the tenant; with `book`, booked first when none exists, in one transaction. */
  pilotArm(tenantId: string, sessionId: string, book: PilotArmBooking | null): Promise<PilotArm | null>;
  /** As `lastSentState`. */
  lastSent(tenantId: string, sessionId: string, surface: TokenSurface): Promise<LastSent | null>;
  /** As `loadTextsHoldingWords`: rows `reach` admits whose content holds any of the words. */
  textsHoldingWords(query: HeldTextQuery): Promise<HeldText[]>;
  /** As `loadContentsWithTag`: team-visible rows whose tags hold `tag` exactly, superseded ones included. */
  contentsWithTag(tenantId: string, tag: string, origins?: readonly string[]): Promise<string[]>;
  /** Saves the handoff `plan` returns, stamped with the key, then marks the key's active snapshots of the session `session-ended`; a failed save closes nothing. */
  endSession(end: SessionEnd): Promise<SessionEndWrite>;
  /** As `saveActiveTaskSnapshot` with a key, which scrubs secrets from the text first. */
  saveSnapshot(tenantId: string, snapshot: TaskSnapshotInput, key: ContinuityKey): Promise<TaskSnapshot>;
  startCompaction(open: CompactionOpen): Promise<void>;
  /** The tenant's record holding the request id, whatever its session. */
  compactionByRequest(tenantId: string, requestId: string): Promise<CompactionRecord | null>;
  /** As `recordSummary`: the session's newest started record in the window moves to summarised with the request id, else one is inserted under `id`. */
  summariseCompaction(summary: CompactionSummary): Promise<CompactionRecord>;
  /** One transaction: the plan's steps in order, the strengthen, then the record `done` with the writes counted; a tombstone a write meets rolls it all back.
   *  After commit, each row's mirror and the remembered counter, best effort. */
  writeCompactionItems(write: CompactionItemsWrite): Promise<CompactionItemsResult>;
  failureOutcome(tenantId: string, requestId: string): Promise<LoggedFailure | null>;
  /** As `recordFailure`; with `settle`, only rewrites the outcome of the tenant's row holding the request id. */
  logFailure(event: CallerFailureLog, settle: boolean): Promise<void>;
}

/** The optional groups: a store sets each one whole or leaves it unset, and a route or MCP tool names the one it needs. */
export interface StoreGroups {
  /** Unset on a store built before them, where hybrid and physics recall under an embedding provider answer 501. */
  readonly vectors: VectorReads;
  readonly keyAudit: KeyAudit;
  readonly keyWrites: KeyWrites;
  /** embedMemory and embedAll with a store need it and `vectors`. */
  readonly vectorWrites: VectorWrites;
  readonly entryWrites: EntryWrites;
  readonly contextReads: ContextReads;
  readonly hooks: HookStore;
}

export type StoreGroup = 'base' | keyof StoreGroups;

export function hasGroup(store: HippoStore, group: StoreGroup): boolean {
  return group === 'base' || store[group] !== undefined;
}

/** The group's methods; a store without them throws StoreNotPortedError, which answers 501 as any unported path does. */
export function requireGroup<G extends keyof StoreGroups>(store: HippoStore, group: G): StoreGroups[G] {
  const groups: Partial<StoreGroups> = store;
  const methods = groups[group];
  if (methods === undefined) throw new StoreNotPortedError(store.kind, group);
  return methods;
}

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an await, since SQLite's lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore extends Partial<StoreGroups> {
  /** 'sqlite' is hippo.db under the served root. Under any other kind, an unported route answers 501 and a hippo.db open inside a request throws. */
  readonly kind: string;
  /** The api_keys row for `keyId` with its scope grants, revoked or not; null when no row matches. */
  findApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** Recall candidates in `loadRecallSearchEntries` order: FTS, then LIKE, then every row in scope. */
  searchRecallEntries(query: string, args: RecallSearchArgs): Promise<MemoryEntry[]>;
  /** The rows among the first 500 ids, a tenant narrowing them, ordered by created, then content, then id, all ascending,
   *  as `loadEntriesByIds` does; the input order is ignored. */
  entriesByIds(ids: readonly string[], tenantId?: string): Promise<MemoryEntry[]>;
  /** The session's active goals and their policies, read together so a goal and its policy never disagree. */
  activeGoals(opts: GetActiveGoalsOpts): Promise<ActiveGoals>;
  /** The first `count` (at most 200) unsuperseded raw rows a tenant, a non-empty session id and non-null `origins` (those projects and
   *  user-global rows) must narrow, by created descending, then content and id ascending, as `loadFreshRawMemories` does. */
  freshRawEntries(count: number, tenantId: string | undefined, sessionId: string | undefined, origins: readonly string[] | null): Promise<MemoryEntry[]>;
  /** The newest active snapshot a non-null `key` must narrow to one owner and project (null only on an unshared hippo.db), then for its session
   *  the newest handoff (same key) and `eventLimit` newest events returned oldest first, each tie broken by the larger id; the caller applies scope. */
  continuity(tenantId: string, eventLimit: number, key: ContinuityKey | null): Promise<ContinuityBlock>;
  /** Resolves a forward claim's tokens to one class and reads its baserate, writing no audit row. */
  planningFallacyEvidence(tenantId: string, classQueryTokens: readonly string[]): Promise<PlanningFallacyEvidence>;
  /** Appends the rows in order, all or none. */
  appendAuditEvents(events: readonly AppendAuditOpts[]): Promise<void>;
  /** Writes the goal log and audit rows in one transaction and rejects with none written if it fails. Then the trace and
   *  the strengthen, each on its own: a failure there logs and still resolves, since the reply is already decided. */
  finishRecall(writes: RecallWrites): Promise<void>;
  /** Adds `recalled` to the one store-wide total_recalled counter, no tenant; the SQLite store also rewrites stats.json. */
  bumpRecallStats(recalled: number): Promise<void>;
  /** One token-ledger row. Throws, so the caller decides whether a ledger failure matters. */
  recordTokens(use: TokenUse): Promise<void>;
  /** Releases the store's connections; `serve()` closes only a store it made itself. */
  close(): Promise<void>;
}

/** The store a request runs on: the served one, else hippo.db under its root, as the CLI and SDK callers have it. */
export function storeFor(ctx: { readonly hippoRoot: string; readonly store?: HippoStore }): HippoStore {
  return ctx.store ?? sqliteStore(ctx.hippoRoot);
}

/** The built-in store: today's synchronous hippo.db functions behind the port, each call on its own short-lived handles, so close has nothing to release. */
export function sqliteStore(hippoRoot: string): HippoStore & StoreGroups {
  return {
    kind: 'sqlite',
    async findApiKey(keyId) {
      return onHandle(hippoRoot, (db) => readApiKeyRecord(db, keyId));
    },
    async searchRecallEntries(query, args) {
      return loadRecallSearchEntries(
        hippoRoot, query, args.limit, args.tenantId, args.requestedScope, args.explicitScopeMode, args.includeSuperseded, args.originProjects, args.ownScope,
      );
    },
    async entriesByIds(ids, tenantId) {
      return loadEntriesByIds(hippoRoot, ids, tenantId);
    },
    async activeGoals(opts) {
      return activeGoalsWithPolicies(hippoRoot, opts);
    },
    async freshRawEntries(count, tenantId, sessionId, origins) {
      return loadFreshRawMemories(hippoRoot, count, tenantId, sessionId, origins ?? undefined);
    },
    async continuity(tenantId, eventLimit, key) {
      return continuityAt(hippoRoot, tenantId, eventLimit, key);
    },
    async planningFallacyEvidence(tenantId, classQueryTokens) {
      return planningFallacyEvidenceAt(hippoRoot, tenantId, classQueryTokens);
    },
    async appendAuditEvents(events) {
      if (events.length === 0) return;
      onHandle(hippoRoot, (db) => withWriteScope(db, 'append_audit_events', () => {
        for (const event of events) appendAuditEvent(db, event);
      }));
    },
    async finishRecall(writes) {
      finishRecallAt(hippoRoot, writes);
    },
    async bumpRecallStats(recalled) {
      updateStats(hippoRoot, { recalled });
    },
    async recordTokens(use) {
      onHandle(hippoRoot, (db) => recordTokenUse(db, use));
    },
    vectors: {
      async embeddingIndexState() {
        return embeddingIndexStateAt(hippoRoot);
      },
      async storedVectors(ids) {
        return loadStoredVectors(hippoRoot, ids);
      },
      async nearestEntries(queryVector, spec) {
        return loadVectorCandidateEntries(hippoRoot, queryVector, spec);
      },
      async physicsParticles(ids) {
        // loadPhysicsState reads every row for an empty list.
        return ids.length === 0 ? new Map() : onHandle(hippoRoot, (db) => loadPhysicsState(db, [...ids]));
      },
    } satisfies VectorReads,
    keyAudit: sqliteKeyAudit(hippoRoot),
    keyWrites: sqliteKeyWrites(hippoRoot),
    vectorWrites: {
      async entriesWithoutVector(query) {
        return onHandle(hippoRoot, (db) => entriesWithoutVectorAt(db, query));
      },
      async writeVectors(write) {
        return onHandle(hippoRoot, (db) => writeVectorsAt(db, write));
      },
    },
    entryWrites: sqliteEntryWrites(hippoRoot),
    contextReads: sqliteContextReads(hippoRoot),
    hooks: sqliteHookStore(hippoRoot),
    async close(): Promise<void> {},
  };
}

function sqliteContextReads(hippoRoot: string): ContextReads {
  return {
    async unfinishedHandoff(tenantId, maxAgeMs, key) {
      return loadLatestHandoff(hippoRoot, tenantId, undefined, { unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' }, key ?? undefined);
    },
    async ambientCandidates(tenantId, { recentNeeded, admit, recall, origins }) {
      return loadAmbientCandidates(hippoRoot, tenantId, recentNeeded, admit, recall, origins);
    },
    async contextCandidates(tenantId, filter) {
      return loadContextCandidates(hippoRoot, tenantId, filter);
    },
    async ambientTallies(tenantId, filter) {
      return loadAmbientTallies(hippoRoot, tenantId, filter);
    },
  };
}

function sqliteKeyWrites(hippoRoot: string): KeyWrites {
  return {
    async createApiKey(mint) {
      onHandle(hippoRoot, (db) => createKeyAt(db, mint));
    },
    async createSelfApiKey(mint) {
      return onHandle(hippoRoot, (db) => createSelfKeyAt(db, mint));
    },
    async listApiKeys(query) {
      return onHandle(hippoRoot, (db) => listApiKeyRows(db, query));
    },
  };
}

function sqliteKeyAudit(hippoRoot: string): KeyAudit {
  return {
    async revokeApiKey(revoke) {
      return onHandle(hippoRoot, (db) => revokeKeyAt(db, revoke));
    },
    async auditEventsAfter(opts) {
      return onHandle(hippoRoot, (db) => listAuditEventsAfter(db, opts));
    },
    async auditHighId() {
      return onHandle(hippoRoot, auditHighIdAt);
    },
  };
}

/** sqliteStore's continuity read, for the synchronous recall that cannot await the port. */
export function continuityAt(hippoRoot: string, tenantId: string, eventLimit: number, key: ContinuityKey | null): ContinuityBlock {
  const activeSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId, key ?? undefined);
  const sessionId = activeSnapshot?.session_id ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? loadLatestHandoff(hippoRoot, tenantId, sessionId, {}, key ?? undefined) : null,
    recentSessionEvents: sessionId ? listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, limit: eventLimit }) : [],
  };
}

/** sqliteStore's finishRecall, for the synchronous recall that cannot await the port. */
export function finishRecallAt(hippoRoot: string, writes: RecallWrites): void {
  onHandle(hippoRoot, (db) => {
    withWriteScope(db, 'finish_recall', () => {
      writeGoalRecallLog(db, localGoalRecallRows(db, writes.goalLog));
      for (const event of writes.audit) appendAuditEvent(db, event);
    });
    // Each opens its own transaction, so neither can share the scope above.
    if (writes.trace) writeRecallTrace(db, writes.trace);
    if (writes.strengthen) strengthenRetrievedInOwnTx(db, writes.strengthen.ids, writes.strengthen.opts);
  });
}
