// The async seam the server reaches its store through, so an add-on can serve from a database other than hippo.db.
import { readApiKeyRecord, type ApiKeyRecord } from './auth.js';
import { appendAuditEvent, listAuditEventsAfter, type AppendAuditOpts, type AuditEvent, type ListAuditAfterOpts } from './audit.js';
import type { ContinuityBlock } from './api/recall-types.js';
import { closeHippoDb, openHippoDb, withWriteScope, type DatabaseSyncLike } from './db.js';
import { StoreNotPortedError } from './db/sqlite-blocked.js';
import { embeddingIndexStateAt, loadStoredVectors, type EmbeddingIndexState } from './embeddings.js';
import {
  activeGoalsWithPolicies, localGoalRecallRows, writeGoalRecallLog,
  type ActiveGoals, type GetActiveGoalsOpts, type GoalRecallLogRow,
} from './goals.js';
import type { MemoryEntry } from './memory.js';
import type { PhysicsParticle } from './physics.js';
import { loadPhysicsState } from './physics-state.js';
import { planningFallacyEvidenceAt, type PlanningFallacyEvidence } from './predictions/planning-fallacy.js';
import { writeRecallTrace, type RecallTraceInput } from './recall-trace.js';
import { loadEntriesByIds, loadFreshRawMemories } from './store/entry-reads.js';
import { auditHighIdAt, revokeKeyAt } from './store/key-audit.js';
import { strengthenRetrievedInOwnTx, type StrengthenOptions } from './store/entry-writes.js';
import { loadLatestHandoff } from './store/handoffs.js';
import { updateStats } from './store/index-and-stats.js';
import { loadRecallSearchEntries, loadVectorCandidateEntries, type OriginFilter, type VectorCandidateSpec } from './store/search-rows.js';
import { type ContinuityKey, listSessionEvents, loadActiveTaskSnapshot } from './store/sessions.js';
import { recordTokenUse, type TokenUse } from './token-ledger.js';

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

/** The optional groups: a store sets each one whole or leaves it unset, and a route or MCP tool names the one it needs. */
export interface StoreGroups {
  /** Unset on a store built before them, where hybrid and physics recall under an embedding provider answer 501. */
  readonly vectors: VectorReads;
  readonly keyAudit: KeyAudit;
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

function onHandle<T>(hippoRoot: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(hippoRoot);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
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
    async close(): Promise<void> {},
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
