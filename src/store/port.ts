// The async store interface and its groups; type-only apart from requireGroup's error, so an add-on can build a store on it alone.
import type { AmbientTallies } from '../core/ambient.js';
import type { AmbientStoreFilter } from './ambient.js';
import type { ApiKeyListRow, ApiKeyRecord, ListApiKeysOpts, NewApiKey } from './auth.js';
import type { AppendAuditOpts, AuditEvent, ListAuditAfterOpts, QueryAuditOpts } from './audit.js';
import { StoreNotPortedError } from '../util/sqlite-blocked.js';
import type { EmbeddingIndexState } from './vector-index.js';
import type { Entity, Relation } from './graph-rows.js';
import type { ActiveGoals, GetActiveGoalsOpts, GoalRecallLogRow } from './goals.js';
import type { SessionHandoff } from '../core/handoff.js';
import type { JsonValue } from '../util/json.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { MemoryEntry } from '../core/memory.js';
import type { PhysicsParticle } from '../core/physics.js';
import type { BriefReceipt, Incident, IncidentFields, ObjectByKind, ObjectFields, ObjectKind, Policy, SavableKind, Skill } from '../core/object-types.js';
import type { PlanningFallacyEvidence } from './planning-fallacy-evidence.js';
import type { ClosureState, Prediction, PredictionBaserate, SavePredictionOpts } from './predictions.js';
import type { QuarantineRow, QuarantineStatus } from './quarantine.js';
import type { ScopeActor } from '../core/recall-scope.js';
import type { RecallTraceInput } from './recall-trace.js';
import type { AmbientLoadResult, AmbientRecallRequest, ContextCandidateFilter, RecentOrigins } from './candidates.js';
import type { GitHubDlqInsert, GitHubRouting } from './connectors/github.js';
import type { SlackDlqInsert, SlackTeamRoute } from './connectors/slack.js';
import type { StrengthenOptions } from './entry-writes.js';
import type { SessionEvent, TaskSnapshot } from './rows.js';
import type { OriginFilter, VectorCandidateSpec } from './search-rows.js';
import type { ContinuityKey } from './sessions.js';
import type { TokenUse } from './token-ledger.js';

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
  /** The `spec.limit ?? 50` rows nearest `queryVector` by `rankVectorRows`, filtered by tenant (when set), kind != 'archived', superseded only with
   * `includeSuperseded`, scope per `RecallScopeFilter`, and origin '' or listed (when `spec.origin` is set). */
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
  /** In one transaction: refuses with `modelMismatch` if `replacesIndex` and not `replaceIndex`; else drops every vector and particle if `replacesIndex`,
   * keeps each writable row (memory in `tenantId`, finite non-empty vector) under `model` with its particle, sets `model`. No audit row. */
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
  /** Upserts the row, its full-text row and one remember row ({kind, scope}) in the entry's tenant; an id held by another tenant rejects with ConflictError.
   * Content from a tenant that tombstoned it rejects with RejectedValueError and writes one reject_refusal row after the rollback, best effort. */
  writeEntry(write: EntryWrite): Promise<void>;
  /** Per id in order, a row of the tenant within reach gets `entryAfterOutcome` (rewrite as writeEntry does) and one outcome row ({good}); other ids skipped.
   * Each read holds the row lock to commit (SELECT ... FOR UPDATE), so a concurrent supersede is not undone. Resolves to the ids applied, repeats kept. */
  applyOutcome(outcome: OutcomeWrite): Promise<string[]>;
  /** Sets the old row's superseded_by if it is within reach and not yet superseded (both checked in the transaction), else rejects NotFoundError or
   * ConflictError. Then writes the successor as writeEntry does and one supersede row ({newId}), all or nothing. */
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
  /** Serialized per (tenant, owner) before the count (BEGIN IMMEDIATE / pg_advisory_xact_lock): revoke the owner's oldest live keys to `perSubject - 1`,
   * then insert the key; append auth_revoke `{ replacedBy }` per revoked key, then auth_create. Live: unrevoked and not expired (NaN counts as expired). */
  createSelfApiKey(mint: SelfKeyMint): Promise<string[]>;
  /** As `listApiKeyRows`: newest inserted first, each with its scope grants; `active` drops revoked rows and an expires_at not above now's toISOString. */
  listApiKeys(query: KeyListQuery): Promise<ApiKeyListRow[]>;
}

/** A claim to save and the memory row that mirrors it into recall: core builds it with
 * `predictionMirror` in the tenant the save names, so every store keeps the same row. */
export interface PredictionSave extends SavePredictionOpts {
  readonly mirror: MemoryEntry;
}

export interface PredictionClose {
  readonly closureState: Exclude<ClosureState, 'open'>;
  readonly actualValue?: number;
  readonly closureNote?: string;
}

/** Which of a tenant's predictions a list reads: every class when `classTag` is unset (it is
 * never empty), every state when `closureState` is, and a closed state only inside a class. */
export type PredictionFilter =
  | { readonly classTag?: string; readonly closureState?: 'open' }
  | { readonly classTag: string; readonly closureState: ClosureState };

export type PredictionListQuery = PredictionFilter & { readonly limit: number; readonly after?: KeysetPosition };

/** The reads and writes behind the predictions routes. createdAt and closedAt are the store's
 * own clock at the write, as `toISOString` gives it, since the list orders createdAt as text. */
export interface Predictions {
  /** In one transaction: writes `mirror` as `EntryWrites.writeEntry` does, inserts the open row under the next id, and appends one predict_create row
   * ({prediction_id, class_tag, has_estimate, target_date}) ahead of the mirror's remember row. Resolves to the row saved. */
  savePrediction(tenantId: string, input: PredictionSave, actor: string): Promise<Prediction>;
  /** Closes the tenant's open row and appends one predict_close row ({prediction_id, closure_state, has_actual}) in one transaction; the mirror stays as saved.
   * A missing or other-tenant id rejects with NotFoundError, an already-closed row with BadRequestError; neither writes anything. */
  closePrediction(tenantId: string, id: number, close: PredictionClose, actor: string): Promise<Prediction>;
  /** The tenant's row; null for a missing id or another tenant's. No audit row. */
  predictionById(tenantId: string, id: number): Promise<Prediction | null>;
  /** At most `limit` rows, newest first: by createdAt compared as text in byte order, then by id, both descending, so the order is total.
   *  `after` keeps only the rows below its (createdAt, id) pair in that order. No audit row. */
  listPredictions(tenantId: string, query: PredictionListQuery): Promise<Prediction[]>;
  /** `predictionBaserateOf` over the tenant's closed (not closed-unknown) rows of the class with an estimate and an actual, in ascending id order (its
   * float sums depend on it). Then appends one predict_baserate row ({class_tag, n_closed}), also for a class with no such row. */
  predictionBaserate(tenantId: string, classTag: string, actor: string): Promise<PredictionBaserate>;
}

/** Which of a tenant's rows of one kind a list reads: every status when `status` is unset, every value of the kind's one filter column (customer, repo)
 * when `filter` is. Neither is ever empty; a kind with no filter column ignores `filter`. */
export interface ObjectListQuery<K extends ObjectKind = ObjectKind> {
  readonly status?: ObjectByKind[K]['status'];
  readonly filter?: string;
  readonly limit: number;
  readonly after?: KeysetPosition;
}

export interface ObjectClose<K extends ObjectKind = ObjectKind> {
  /** The statuses a close may start from; core owns the rule and its refusal text. */
  readonly from: readonly ObjectByKind[K]['status'][];
  readonly actor: string;
  /** The row's closedAt: core's clock, as `toISOString` gives it. */
  readonly at: string;
}

/** One row to save and the memory that mirrors it into recall: core builds the mirror in the
 * tenant the save names with the kind as its `source`, so every store keeps the same row. */
export interface ObjectSave<K extends SavableKind = SavableKind> {
  readonly mirror: MemoryEntry;
  readonly fields: ObjectFields[K];
  /** The tenant's active row this one replaces. */
  readonly supersedesId?: number;
  /** Stored on a successor of a versioned kind only; a first version and a decision keep none. */
  readonly changeSummary?: string;
  readonly actor: string;
  /** The new row's createdAt and the replaced row's supersededAt: core's clock, as `toISOString` gives it, since the list orders createdAt as text. */
  readonly at: string;
}

/** Why a save or close wrote nothing: the tenant holds no such row (`missing`), the row's `status` is not one the write may start from, another writer moved it
 *  between the check and the write (`raced`), or the written row could not be read back (`vanished`). Core turns each into its own error text. */
export type ObjectRefusal =
  | { readonly refused: 'missing' }
  | { readonly refused: 'status'; readonly status: string }
  | { readonly refused: 'raced' }
  | { readonly refused: 'vanished' };

/** Tells a refusal from the row a write answered; no row carries a `refused` key. */
export function isObjectRefusal<T extends object>(written: T | ObjectRefusal): written is ObjectRefusal {
  return 'refused' in written;
}

/** An incident to open and the memory that mirrors it into recall, built as `ObjectSave` has it. */
export interface IncidentOpen {
  readonly mirror: MemoryEntry;
  readonly fields: IncidentFields;
  readonly actor: string;
  /** The row's createdAt: core's clock, as `toISOString` gives it. */
  readonly at: string;
}

/** Why an incident was not opened: `memoryId` is the first linked id, in the order
 * given, that is no memory of the tenant; or the written row could not be read back. */
export type IncidentOpenRefusal =
  | { readonly refused: 'unlinked'; readonly memoryId: string }
  | { readonly refused: 'vanished' };

export interface IncidentResolve {
  /** The row's resolutionText; core has checked it is not blank. */
  readonly text: string;
  readonly actor: string;
  /** The row's resolvedAt: core's clock, as `toISOString` gives it. */
  readonly at: string;
}

/** `asOf` is an instant as `toISOString` gives it, so it compares as text against validFrom and validTo; `name` keeps one policyName, and may be empty. */
export interface PoliciesInForceQuery {
  readonly asOf: string;
  readonly name?: string;
  readonly limit: number;
}

/** The reads and writes behind the typed-object routes. An audit row names the object under the kind's id key (decision_id, incident_id, ...).
 * A row belongs to one tenant: another tenant's id reads as missing in every method. */
export interface Objects {
  /** At most `limit` rows of the kind, newest first: by createdAt compared as text in byte order, then by id, both descending, so the order is total.
   *  `after` keeps only the rows below its (createdAt, id) pair in that order. No audit row. */
  listObjects<K extends ObjectKind>(tenantId: string, kind: K, query: ObjectListQuery<K>): Promise<ObjectByKind[K][]>;
  /** The tenant's row; null for a missing id or another tenant's. No audit row. */
  objectById<K extends ObjectKind>(tenantId: string, kind: K, id: number): Promise<ObjectByKind[K] | null>;
  /** In one transaction: moves the tenant's row from a `close.from` status to closed at `close.at` and appends one <kind>_close row; a refusal writes nothing.
   * After the commit a kind the graph reads has its graph rows dropped and its mirror queued for a rebuild; a failure there is logged, never thrown. */
  closeObject<K extends ObjectKind>(tenantId: string, kind: K, id: number, close: ObjectClose<K>): Promise<ObjectByKind[K] | ObjectRefusal>;
  /** In one transaction, in order: writes `mirror` as `EntryWrites.writeEntry` does; inserts the row active (version 1, or the replaced row's plus one);
   * with `supersedesId`, supersedes that row; appends the supersede and create rows. A refusal (`missing`, `status`, `raced`, `vanished`) writes nothing. */
  saveObject<K extends SavableKind>(tenantId: string, kind: K, save: ObjectSave<K>): Promise<ObjectByKind[K] | ObjectRefusal>;
  /** In one transaction, in order: writes `mirror` as `EntryWrites.writeEntry` does; checks each linked id is a memory of the tenant; inserts the row open
   * under the next id; appends the incident_open row, then the mirror's remember row. A refusal leaves no mirror, row or audit row. */
  openIncident(tenantId: string, open: IncidentOpen): Promise<Incident | IncidentOpenRefusal>;
  /** In one transaction: moves the tenant's incident from open to resolved with `resolve.text` and `resolve.at`, then appends one incident_resolve row.
   * A refusal (`missing`, `status`, or `vanished`) writes nothing. */
  resolveIncident(tenantId: string, id: number, resolve: IncidentResolve): Promise<Incident | ObjectRefusal>;
  /** Policies in force at `asOf` (max `limit`): not closed, validFrom <= asOf < validTo (or unset), and active or superseded by a row whose validFrom is
   * after asOf. Newest validFrom first, compared as text in byte order, then larger id. No audit row. */
  policiesInForce(tenantId: string, query: PoliciesInForceQuery): Promise<Policy[]>;
  /** At most `limit` of the tenant's active skills, by skillName ascending compared as text in byte order, then by id ascending. No audit row. */
  activeSkillsByName(tenantId: string, limit: number): Promise<Skill[]>;
  /** At most `limit` of the tenant's memories carrying `tag` (tag list as JSON, matched between double quotes, unescaped, ASCII case-folded) whose source
   * is not project_brief and whose scope recall admits with no scope asked, newest first by created (text, byte order) then id. No audit row. */
  briefReceipts(tenantId: string, tag: string, limit: number): Promise<BriefReceipt[]>;
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

/** The two fields a paged walk judges a row under the summary by. */
export type DescendantOrigin = Pick<MemoryEntry, 'scope' | 'origin_project'>;

export interface DescendantPage {
  /** How many rows the caller reads whole, counted from the first row of the first level. */
  readonly rows: number;
  /** `DescendantWalk.admit` for a row under the summary, judged on these two fields alone; the two must agree on every such row. */
  readonly admit: (row: DescendantOrigin) => boolean;
}

export interface DescendantWalk {
  /** Levels to read under the summary. */
  readonly depth: number;
  /** Asked of the summary, then of each child read: a refused row is left out of the answer and nothing under it is read. */
  readonly admit: (row: MemoryEntry) => boolean;
  /** Set by a caller that shows only the first rows. A store may ignore it; one that honours it returns just those rows and counts every level in `sizes`. */
  readonly page?: DescendantPage;
}

export interface SummaryDescendants {
  readonly summary: MemoryEntry;
  /** The admitted rows of each level, the summary's own children first; a level with none ends the list. */
  readonly levels: MemoryEntry[][];
  /** Set only by a store that honoured `walk.page`: how many rows each level admits, while `levels` holds just the page, in the same order. */
  readonly sizes?: readonly number[];
}

/** The reads behind session assembly and summary drill-down. None writes an audit row. */
export interface DagReads {
  /** The newest `cap` rows by created then id, returned oldest first (created, then id,
   * ascending) as `loadSessionRawMemories` does; an empty session id reads nothing. */
  sessionRawEntries(query: SessionRawWindow): Promise<MemoryEntry[]>;
  /** How many rows the session holds with no cap, under the scope rule `passesScopeFilterForRecall`
   * applies, so the count never tells of a row the caller could not read. */
  sessionRawCount(query: SessionRawCount): Promise<number>;
  /** The tenant's row `id` and up to `walk.depth` levels under it, read in one call so no write of this process lands between levels; null if no such row.
   * Each level lists the children of the one above, parent by parent, children by created then id ascending; a row is listed once, at its first level. */
  summaryWithDescendants(tenantId: string, id: string, walk: DescendantWalk): Promise<SummaryDescendants | null>;
}

/** The read behind the audit list. It writes no audit row. */
export interface AuditLog {
  /** One tenant's rows newest first, by ts then id descending, narrowed by `op` and by `since` (ts at or after it); `limit` is clamped to 1..10001 and
   *  defaults to 100, and `after` resumes below the (ts, id) position a page ended on. */
  listAuditEvents(query: QueryAuditOpts): Promise<AuditEvent[]>;
}

/** What GET /ready asks of a store. */
export interface Readiness {
  /** Resolves once one cheap read has answered; rejects with the store's own error when it cannot. */
  ping(): Promise<void>;
}

/** Which of a tenant's quarantine records a list reads; `limit` is 100 when unset. */
export interface QuarantineListQuery {
  readonly status: QuarantineStatus | 'all';
  readonly limit?: number;
  readonly after?: KeysetPosition;
}

/** A quarantine record and the whole content of the memory it holds; null once the tenant has no such memory row. */
export interface QuarantinedMemory extends QuarantineRow {
  readonly content: string | null;
}

/** Why a decision wrote nothing: the tenant holds no record for the id (another tenant's id reads the same), or the record was decided before. */
export type QuarantineRefusal =
  | { readonly outcome: 'not_quarantined' }
  | { readonly outcome: 'already_decided'; readonly status: Exclude<QuarantineStatus, 'pending'> };

/** 'scope_moved': the memory row is gone from the tenant or no longer under the scope its quarantine gave it. */
export type QuarantineApproval = { readonly outcome: 'approved' } | QuarantineRefusal | { readonly outcome: 'scope_moved' };
export type QuarantineRejection = { readonly outcome: 'rejected' } | QuarantineRefusal;

/** The review queue behind the quarantine routes. A refusal is a resolved value, never a rejection, and writes nothing. */
export interface Quarantine {
  /** At most `limit` of the tenant's records, newest first (quarantinedAt as text in byte order, then memoryId, both descending); `after` keeps only
   * records below its pair. 'pending' leaves out a record whose memory row is gone; every other status keeps it, with null content. No audit row. */
  listQuarantined(tenantId: string, query: QuarantineListQuery): Promise<QuarantinedMemory[]>;
  /** In one transaction, all or none: restores the memory's originalScope if it is in the tenant and still under `quarantine:private:...`;
   * marks the record approved (decidedAt from the store's clock, decidedBy `actor`); appends one quarantine_approve row ({originalScope}). */
  approveQuarantined(tenantId: string, id: string, actor: string): Promise<QuarantineApproval>;
  /** In one transaction, both or neither: marks the record rejected (decidedAt/decidedBy as approve) and appends one quarantine_reject row.
   * The memory row is not touched, so it stays under its quarantine scope and a record with no memory row can still be rejected. */
  rejectQuarantined(tenantId: string, id: string, actor: string): Promise<QuarantineRejection>;
}

/** What one graph view reads. `limit` is a positive integer capping each read on its own; newest means createdAt, then id, both descending. A row shows
 * when it cites no memory, or its memory is in the tenant with a null scope or one `canReadScope(reader, scope)` admits; no `reader` shows every row. */
export interface GraphViewQuery {
  /** Unset reads the whole graph. Set, the start entities are the first `limit` of exactly this name (lowest id first) that show; none left answers empty.
   * Per 400 start ids, the newest `limit` relations with an end among them join in, each adding its other end to the ids held, until `limit` ids are held. */
  readonly entity?: string;
  readonly limit: number;
  readonly reader?: ScopeActor;
}

export interface GraphRows {
  readonly entities: Entity[];
  /** May name an entity `entities` lacks; the caller drops such a relation. */
  readonly relations: Relation[];
  /** Judged before a row is hidden: true when start entities, joined relations, returned relations or (whole graph) returned entities came back `limit` long,
   * or the walk held `limit` ids with a relation still to join. */
  readonly truncated: boolean;
}

/** The rows behind GET /v1/graph. */
export interface GraphReads {
  /** Every read from one snapshot, then rows that do not show are dropped. Whole graph: the tenant's newest `limit` entities and relations.
   * From a name: the entities of the ids held (id ascending, 400 at a time) and the newest `limit` relations with both ends among those ids. */
  graphRows(tenantId: string, query: GraphViewQuery): Promise<GraphRows>;
}

/** The source event a connector's write answers, by the source's own key. The store logs each key once per connector, across every tenant. */
export type ConnectorEvent =
  | { readonly connector: 'slack'; readonly eventId: string }
  | { readonly connector: 'github'; readonly idempotencyKey: string; readonly deliveryId: string; readonly eventName: string };

/** An entry a connector brings in. `quarantine` is the review record of flagged content, whose entry already carries its quarantine scope. */
export interface ConnectorWrite extends EntryWrite {
  readonly event?: ConnectorEvent;
  readonly quarantine?: { readonly originalScope: string | null; readonly reason: string };
}

/** 'duplicate': the event's key was logged before; `memoryId` is the id its log row holds, null for an event logged with no memory. */
export type ConnectorWriteOutcome =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'duplicate'; readonly memoryId: string | null };

export interface ConnectorArchive extends RawArchive {
  readonly event: ConnectorEvent;
}

/** A connector's writes with the rows that must commit with them: the event log row
 * that turns a redelivery into a no-op, and the quarantine record of flagged content. */
export interface ConnectorWrites {
  /** entryWrites.writeEntry plus, in its transaction: with `quarantine`, one pending record and quarantine row; with `event`, one log row. All commit or none.
   * A key logged before resolves 'duplicate' and stores nothing (never a rejection); every other refusal is writeEntry's own, decided first. */
  writeConnectorEntry(write: ConnectorWrite): Promise<ConnectorWriteOutcome>;
  /** entryWrites.archiveRaw plus, in its transaction, one log row for `event` naming the archived id, so a redelivery finds it logged; a failed log write
   * undoes the archive. A key logged before keeps its row and does not stop the archive. Reach and every rejection are archiveRaw's own. */
  archiveConnectorEntry(archive: ConnectorArchive): Promise<string>;
}

/** What the event log holds for one event's key; `memoryId` is null for an event logged with no memory. */
export type ConnectorEventRecord = { readonly seen: false } | { readonly seen: true; readonly memoryId: string | null };

export interface DeletionLookup {
  readonly event: ConnectorEvent;
  readonly artifactRef: string;
  readonly tenantId: string;
}

/** `memoryId` is null when the tenant holds no raw row for the artifact. */
export type DeletionTarget = { readonly seen: true } | { readonly seen: false; readonly memoryId: string | null };

export interface ArtifactArchive {
  readonly tenantId: string;
  readonly actor: string;
  readonly artifactRef: string;
  readonly reason: string;
  readonly event: Extract<ConnectorEvent, { readonly connector: 'github' }>;
}

/** One payload a webhook could not use, already redacted, for the dead-letter queue of its connector. */
export type ConnectorDeadLetter = ({ readonly connector: 'slack' } & SlackDlqInsert) | ({ readonly connector: 'github' } & GitHubDlqInsert);

/** What a connector delivery reads and writes beside connectorWrites: the event log,
 * tenant routing, the dead-letter queue and the archive of a deleted artifact. */
export interface ConnectorEvents {
  /** The log row of the event's key, in its connector's own key space. */
  eventRecord(event: ConnectorEvent): Promise<ConnectorEventRecord>;
  /** Logs an event that stored no memory, so its redelivery finds it. A key logged before keeps its row, the memory id it names included. */
  markEventSeen(event: ConnectorEvent): Promise<void>;
  /** Both reads on one snapshot: an event logged before answers `seen`, else the raw row the
   * tenant holds for the artifact. Another tenant's row under the same ref is never returned. */
  deletionTarget(lookup: DeletionLookup): Promise<DeletionTarget>;
  /** A logged event answers `duplicate` and changes nothing. Else one transaction archives every raw row of the artifact (archive_raw row each, under `actor`)
   * and logs the event naming the first, or no memory if none; one failed archive undoes all and the log row. No reach check. */
  archiveDeletedArtifact(archive: ArtifactArchive): Promise<{ readonly duplicate: boolean; readonly archived: number }>;
  /** The tenant a Slack team is registered to, or how many workspaces are registered when it is not. */
  slackTeamRoute(teamId: string): Promise<SlackTeamRoute>;
  /** The tenant of the installation, or of the repository when no installation is named, with the size of both routing tables. */
  githubRouting(query: { readonly installationId?: string | null; readonly repoFullName?: string | null }): Promise<GitHubRouting>;
  /** Appends the row and answers its id. */
  parkDeadLetter(letter: ConnectorDeadLetter): Promise<number>;
}

/** `storedVectors` with no number[] copy, for a store that holds vectors as Float32 bytes. */
export interface VectorViews {
  /** The same ids and values as `VectorReads.storedVectors`, each value a Float32 view. */
  storedVectorViews(ids: readonly string[]): Promise<Map<string, Float32Array>>;
}

/** The optional groups: a store sets each one whole or leaves it unset, and a route or MCP tool names the one it needs. */
export interface StoreGroups {
  /** Unset on a store built before them, where hybrid and physics recall under an embedding provider answer 501. */
  readonly vectors: VectorReads;
  /** Unset on a store without them, where recall scores the number[] copies `vectors` returns, to the same ranking. */
  readonly vectorViews: VectorViews;
  readonly keyAudit: KeyAudit;
  readonly keyWrites: KeyWrites;
  /** embedMemory and embedAll with a store need it and `vectors`. */
  readonly vectorWrites: VectorWrites;
  readonly entryWrites: EntryWrites;
  readonly contextReads: ContextReads;
  readonly predictions: Predictions;
  readonly dagReads: DagReads;
  readonly auditLog: AuditLog;
  readonly quarantine: Quarantine;
  readonly graphReads: GraphReads;
  /** Unset on a store built before it, where a write that carries a connector event or untrusted content answers 501. */
  readonly connectorWrites: ConnectorWrites;
  /** Unset on a store built before it, where both connector webhooks answer 501. */
  readonly connectorEvents: ConnectorEvents;
  readonly objects: Objects;
  /** Unset on a store built before it, where GET /ready answers 200 with `store: "unchecked"`. */
  readonly readiness: Readiness;
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

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an
 * await, since SQLite's lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
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
