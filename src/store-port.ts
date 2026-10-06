// The async seam the server reaches its store through, so an add-on can serve from a database other than hippo.db.
import { readApiKeyRecord, type ApiKeyRecord } from './auth.js';
import { appendAuditEvent, type AppendAuditOpts } from './audit.js';
import type { ContinuityBlock } from './api/recall-types.js';
import { closeHippoDb, openHippoDb, withWriteScope, type DatabaseSyncLike } from './db.js';
import {
  getActiveGoalsWithDb, loadGoalPolicies, writeGoalRecallLog,
  type GetActiveGoalsOpts, type Goal, type GoalRecallLogRow, type RetrievalPolicy,
} from './goals.js';
import type { MemoryEntry } from './memory.js';
import { resolveClassFromTokens, type ClassResolution } from './predictions/planning-fallacy.js';
import { computePredictionBaserate, type PredictionBaserate } from './predictions/store.js';
import { writeRecallTraceAtRoot, type RecallTraceInput } from './recall-trace.js';
import { loadEntriesByIds, loadFreshRawMemories } from './store/entry-reads.js';
import { strengthenRetrieved as strengthenRetrievedAt, type StrengthenOptions } from './store/entry-writes.js';
import { loadLatestHandoff } from './store/handoffs.js';
import { bumpStats } from './store/index-and-stats.js';
import type { LegacyStats } from './store/rows.js';
import { loadRecallSearchEntries, type OriginFilter } from './store/search-rows.js';
import { listSessionEvents, loadActiveTaskSnapshot } from './store/sessions.js';
import { recordTokenUse, type TokenUse } from './token-ledger.js';

/** The arguments of `loadRecallSearchEntries` after the query, by name. */
export interface RecallSearchArgs {
  readonly limit: number;
  readonly tenantId?: string;
  readonly requestedScope?: string;
  readonly explicitScopeMode: 'exact' | 'additive';
  readonly includeSuperseded: boolean;
  readonly originProjects?: OriginFilter;
}

/** A session's active goals, oldest first, and the retrieval policy of each goal that names one. */
export interface ActiveGoals {
  readonly goals: Goal[];
  readonly policies: ReadonlyMap<string, RetrievalPolicy>;
}

/** The prediction class a forward claim resolves to, and that class's closed-prediction stats when one resolved. */
export interface PlanningFallacyEvidence extends ClassResolution {
  readonly baserate: PredictionBaserate | null;
}

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an await, since SQLite's lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore {
  /** 'sqlite' is hippo.db under the served root. Under any other kind, an unported route answers 501 and a hippo.db open inside a request throws. */
  readonly kind: string;
  /** The api_keys row for `keyId` with its scope grants, revoked or not; null when no row matches. */
  findApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** Recall candidates in `loadRecallSearchEntries` order: FTS, then LIKE, then every row in scope. */
  searchRecallEntries(query: string, args: RecallSearchArgs): Promise<MemoryEntry[]>;
  /** The rows among the first 500 ids, oldest first; a tenant narrows them. */
  entriesByIds(ids: readonly string[], tenantId?: string): Promise<MemoryEntry[]>;
  /** The session's active goals and their policies, read together so a goal and its policy never disagree. */
  activeGoals(opts: GetActiveGoalsOpts): Promise<ActiveGoals>;
  /** The newest `count` current raw rows, at most 200; a session id narrows them to that session. */
  freshRawEntries(count: number, tenantId?: string, sessionId?: string): Promise<MemoryEntry[]>;
  /** The active snapshot and, for its session only, the latest handoff and newest events; the caller applies scope. */
  continuity(tenantId: string, eventLimit: number): Promise<ContinuityBlock>;
  /** Resolves a forward claim's tokens to one class and reads its baserate, writing no audit row. */
  planningFallacyEvidence(tenantId: string, classQueryTokens: readonly string[]): Promise<PlanningFallacyEvidence>;
  /** Appends the rows in order, all or none. */
  appendAuditEvents(events: readonly AppendAuditOpts[]): Promise<void>;
  /** The new trace id, or null when the write failed: a trace is observability, so it never fails a recall. */
  writeRecallTrace(input: RecallTraceInput): Promise<number | null>;
  /** The ids found and strengthened; a failed write finds none and never fails the recall. */
  strengthenRetrieved(ids: readonly string[], opts: StrengthenOptions): Promise<Set<string>>;
  /** Writes the rows whose memory lives in this store; a re-recall within one goal's life adds nothing. */
  logGoalRecall(rows: readonly GoalRecallLogRow[]): Promise<void>;
  /** Every counter after adding `recalled`; core still writes the stats mirror file. */
  bumpRecallStats(recalled: number): Promise<LegacyStats>;
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

/** The built-in store: today's synchronous hippo.db functions behind the port, each call on its own short-lived handles, so close has nothing to release. */
export function sqliteStore(hippoRoot: string): HippoStore {
  return {
    kind: 'sqlite',
    async findApiKey(keyId) {
      return onHandle(hippoRoot, (db) => readApiKeyRecord(db, keyId));
    },
    async searchRecallEntries(query, args) {
      return loadRecallSearchEntries(
        hippoRoot, query, args.limit, args.tenantId, args.requestedScope, args.explicitScopeMode, args.includeSuperseded, args.originProjects,
      );
    },
    async entriesByIds(ids, tenantId) {
      return loadEntriesByIds(hippoRoot, ids, tenantId);
    },
    async activeGoals(opts) {
      return onHandle(hippoRoot, (db) => {
        const goals = getActiveGoalsWithDb(db, opts);
        return { goals, policies: loadGoalPolicies(db, goals) };
      });
    },
    async freshRawEntries(count, tenantId, sessionId) {
      return loadFreshRawMemories(hippoRoot, count, tenantId, sessionId);
    },
    async continuity(tenantId, eventLimit) {
      const activeSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);
      const sessionId = activeSnapshot?.session_id ?? undefined;
      return {
        activeSnapshot,
        sessionHandoff: sessionId ? loadLatestHandoff(hippoRoot, tenantId, sessionId) : null,
        recentSessionEvents: sessionId ? listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, limit: eventLimit }) : [],
      };
    },
    async planningFallacyEvidence(tenantId, classQueryTokens) {
      const resolution = resolveClassFromTokens(hippoRoot, tenantId, classQueryTokens);
      // The recall's own recall_autodebias_hint row carries the stats, so the predict_baserate row stays off.
      const baserate = resolution.classTag ? computePredictionBaserate(hippoRoot, tenantId, resolution.classTag, 'recall', false) : null;
      return { ...resolution, baserate };
    },
    async appendAuditEvents(events) {
      if (events.length === 0) return;
      onHandle(hippoRoot, (db) => withWriteScope(db, 'append_audit_events', () => {
        for (const event of events) appendAuditEvent(db, event);
      }));
    },
    async writeRecallTrace(input) {
      return writeRecallTraceAtRoot(hippoRoot, input);
    },
    async strengthenRetrieved(ids, opts) {
      return strengthenRetrievedAt(hippoRoot, ids, opts);
    },
    async logGoalRecall(rows) {
      if (rows.length === 0) return;
      onHandle(hippoRoot, (db) => withWriteScope(db, 'log_goal_recall', () => {
        const ids = [...new Set(rows.map((r) => r.memoryId))];
        // goal_recall_log.memory_id references memories, so a global row's id would fail the insert.
        // SAFETY: the SELECT projects exactly one column, `id`.
        const local = db.prepare(`SELECT id FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string }>;
        const localIds = new Set(local.map((r) => r.id));
        writeGoalRecallLog(db, rows.filter((r) => localIds.has(r.memoryId)));
      }));
    },
    async bumpRecallStats(recalled) {
      return bumpStats(hippoRoot, { recalled });
    },
    async recordTokens(use) {
      onHandle(hippoRoot, (db) => recordTokenUse(db, use));
    },
    async close(): Promise<void> {},
  };
}
