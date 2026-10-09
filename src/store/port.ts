// The async store interface and its groups; type-only apart from requireGroup's error, so an add-on can build a store on it alone.
import type { AmbientTallies } from '../ambient.js';
import type { AmbientStoreFilter } from '../ambient-store.js';
import type { ApiKeyListRow, ApiKeyRecord, ListApiKeysOpts, NewApiKey } from '../auth.js';
import type { AppendAuditOpts, AuditEvent, ListAuditAfterOpts } from '../audit.js';
import { StoreNotPortedError } from '../util/sqlite-blocked.js';
import type { EmbeddingIndexState } from '../embeddings.js';
import type { ActiveGoals, GetActiveGoalsOpts, GoalRecallLogRow } from '../goals.js';
import type { SessionHandoff } from '../handoff.js';
import type { JsonValue } from '../json.js';
import type { KeysetPosition } from '../keyset.js';
import type { MemoryEntry } from '../memory.js';
import type { PhysicsParticle } from '../physics.js';
import type { PlanningFallacyEvidence } from './planning-fallacy-evidence.js';
import type { ClosureState, Prediction, PredictionBaserate, SavePredictionOpts } from './predictions.js';
import type { RecallTraceInput } from '../recall-trace.js';
import type { AmbientLoadResult, AmbientRecallRequest, ContextCandidateFilter, RecentOrigins } from './candidates.js';
import type { StrengthenOptions } from './entry-writes.js';
import type { SessionEvent, TaskSnapshot } from './rows.js';
import type { OriginFilter, VectorCandidateSpec } from './search-rows.js';
import type { ContinuityKey } from './sessions.js';
import type { TokenUse } from '../token-ledger.js';

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

/** A claim to save and the memory row that mirrors it into recall: core builds it with `predictionMirror` in the tenant the save names, so every store keeps the same row. */
export interface PredictionSave extends SavePredictionOpts {
  readonly mirror: MemoryEntry;
}

export interface PredictionClose {
  readonly closureState: Exclude<ClosureState, 'open'>;
  readonly actualValue?: number;
  readonly closureNote?: string;
}

/** Which of a tenant's predictions a list reads: every class when `classTag` is unset (it is never empty), every state when `closureState` is, and a closed state only inside a class. */
export type PredictionFilter =
  | { readonly classTag?: string; readonly closureState?: 'open' }
  | { readonly classTag: string; readonly closureState: ClosureState };

export type PredictionListQuery = PredictionFilter & { readonly limit: number; readonly after?: KeysetPosition };

/** The reads and writes behind the predictions routes. createdAt and closedAt are the store's own clock at the write, as `toISOString` gives it, since the list orders createdAt as text. */
export interface Predictions {
  /** In one transaction: writes `mirror` as `EntryWrites.writeEntry` does, inserts the open row pointing at it under the next id, and appends one predict_create row
   *  ({prediction_id, class_tag, has_estimate, target_date}, target the id) ahead of the mirror's remember row. Resolves to the row saved. */
  savePrediction(tenantId: string, input: PredictionSave, actor: string): Promise<Prediction>;
  /** Closes the tenant's open row and appends one predict_close row ({prediction_id, closure_state, has_actual}, target the id) in one transaction; the mirror stays as saved. A missing
   *  id or another tenant's rejects with NotFoundError `closePrediction: prediction <id> not found for tenant <tenantId>`, a row already closed with BadRequestError, neither writing anything. */
  closePrediction(tenantId: string, id: number, close: PredictionClose, actor: string): Promise<Prediction>;
  /** The tenant's row; null for a missing id or another tenant's. No audit row. */
  predictionById(tenantId: string, id: number): Promise<Prediction | null>;
  /** At most `limit` rows, newest first: by createdAt compared as text in byte order, then by id, both descending, so the order is total.
   *  `after` keeps only the rows below its (createdAt, id) pair in that order. No audit row. */
  listPredictions(tenantId: string, query: PredictionListQuery): Promise<Prediction[]>;
  /** `predictionBaserateOf` over the tenant's rows of the class that are closed (not closed-unknown) with an estimate and an actual, handed over in ascending id order
   *  because its float sums depend on the order. Then appends one predict_baserate row ({class_tag, n_closed}, target the class), for a class with no such row too. */
  predictionBaserate(tenantId: string, classTag: string, actor: string): Promise<PredictionBaserate>;
}

/** One session's unsuperseded raw rows inside a tenant; `origins` keeps those projects' rows and rows of no project, unset keeps every origin. */
export interface SessionRawQuery {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly origins?: readonly string[];
}

export interface SessionRawWindow extends SessionRawQuery {
  /** How many of the newest rows to read; zero or less reads them all. */
  readonly cap: number;
}

export interface SessionRawCount extends SessionRawQuery {
  /** Counts rows of exactly this scope; unset or empty counts the rows the default deny admits. */
  readonly scope?: string;
  /** The caller's personal scope, which the default deny admits. */
  readonly ownScope?: string;
}

export interface DescendantWalk {
  /** Levels to read under the summary. */
  readonly depth: number;
  /** Asked of the summary, then of each child read: a refused row is left out of the answer and nothing under it is read. */
  readonly admit: (row: MemoryEntry) => boolean;
}

export interface SummaryDescendants {
  readonly summary: MemoryEntry;
  /** The admitted rows of each level, the summary's own children first; a level with none ends the list. */
  readonly levels: MemoryEntry[][];
}

/** The reads behind session assembly and summary drill-down. None writes an audit row. */
export interface DagReads {
  /** The newest `cap` rows by created then id, returned oldest first (created, then id, ascending) as `loadSessionRawMemories` does; an empty session id reads nothing. */
  sessionRawEntries(query: SessionRawWindow): Promise<MemoryEntry[]>;
  /** How many rows the session holds with no cap, under the scope rule `passesScopeFilterForRecall` applies, so the count never tells of a row the caller could not read. */
  sessionRawCount(query: SessionRawCount): Promise<number>;
  /** The tenant's row `id` and up to `walk.depth` levels under it, read in one call so no write of this process lands between two levels; null when the tenant holds no such row.
   *  A level lists the children of the level above it, parent by parent in that level's order and each parent's children by created then id ascending; a row is listed once, at the first level that reaches it. */
  summaryWithDescendants(tenantId: string, id: string, walk: DescendantWalk): Promise<SummaryDescendants | null>;
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
  readonly predictions: Predictions;
  readonly dagReads: DagReads;
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

/** `T` with each method answering its value instead of a Promise of it, groups included: the port as a synchronous store has it. */
export type Sync<T> = T extends (...args: infer A) => Promise<infer R> ? (...args: A) => R
  : T extends object ? { [K in keyof T]: Sync<T[K]> } : T;

export interface ContinuityBlock {
  activeSnapshot: TaskSnapshot | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEvent[];
}
