// The async seam the server reaches its store through, so an add-on can serve from a database other than hippo.db.
import { readApiKeyRecord, type ApiKeyRecord } from './auth.js';
import { appendAuditEvent, type AppendAuditOpts } from './audit.js';
import type { ContinuityBlock } from './api/recall-types.js';
import { closeHippoDb, openHippoDb, withWriteScope, type DatabaseSyncLike } from './db.js';
import {
  activeGoalsWithPolicies, localGoalRecallRows, writeGoalRecallLog,
  type ActiveGoals, type GetActiveGoalsOpts, type GoalRecallLogRow,
} from './goals.js';
import type { MemoryEntry } from './memory.js';
import { planningFallacyEvidenceAt, type PlanningFallacyEvidence } from './predictions/planning-fallacy.js';
import { writeRecallTrace, type RecallTraceInput } from './recall-trace.js';
import { loadEntriesByIds, loadFreshRawMemories } from './store/entry-reads.js';
import { strengthenRetrievedInOwnTx, type StrengthenOptions } from './store/entry-writes.js';
import { loadLatestHandoff } from './store/handoffs.js';
import { updateStats } from './store/index-and-stats.js';
import { loadRecallSearchEntries, type OriginFilter } from './store/search-rows.js';
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
  /** The caller's personal scope, which the default deny admits. */
  readonly ownScope?: string;
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

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an await, since SQLite's lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore {
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
  /** The first `count` (at most 200) unsuperseded raw rows, a tenant, a non-empty session id and `origins` (those projects and
   *  user-global rows) narrowing them, by created descending, then content and id ascending, as `loadFreshRawMemories` does. */
  freshRawEntries(count: number, tenantId?: string, sessionId?: string, origins?: readonly string[]): Promise<MemoryEntry[]>;
  /** The newest active snapshot, `key` narrowing it to one owner and project, then for its session the newest handoff (same key)
   *  and `eventLimit` newest events returned oldest first, each tie broken by the larger id, as `continuityAt` does; the caller applies scope. */
  continuity(tenantId: string, eventLimit: number, key?: ContinuityKey): Promise<ContinuityBlock>;
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
export function sqliteStore(hippoRoot: string): HippoStore {
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
      return loadFreshRawMemories(hippoRoot, count, tenantId, sessionId, origins);
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
    async close(): Promise<void> {},
  };
}

/** sqliteStore's continuity read, for the synchronous recall that cannot await the port. */
export function continuityAt(hippoRoot: string, tenantId: string, eventLimit: number, key?: ContinuityKey): ContinuityBlock {
  const activeSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId, key);
  const sessionId = activeSnapshot?.session_id ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? loadLatestHandoff(hippoRoot, tenantId, sessionId, {}, key) : null,
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
