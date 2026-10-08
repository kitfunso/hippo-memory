// The built-in SQLite adapter behind the store port.
import { loadAmbientTallies } from '../../ambient-store.js';
import { listApiKeyRows, readApiKeyRecord } from '../../auth.js';
import { appendAuditEvent, listAuditEventsAfter } from '../../audit.js';
import { withWriteScope } from '../../db.js';
import { embeddingIndexStateAt, loadStoredVectors } from '../../embeddings.js';
import { activeGoalsWithPolicies, localGoalRecallRows, writeGoalRecallLog } from '../../goals.js';
import { loadPhysicsState } from '../../physics-state.js';
import { planningFallacyEvidenceAt } from '../../predictions/planning-fallacy.js';
import { writeRecallTrace } from '../../recall-trace.js';
import { recordTokenUse } from '../../token-ledger.js';
import { loadAmbientCandidates, loadContextCandidates } from '../candidates.js';
import { loadEntriesByIds, loadFreshRawMemories } from '../entry-reads.js';
import { strengthenRetrievedInOwnTx } from '../entry-writes.js';
import { sqliteEntryWrites } from '../entry-writes-group.js';
import { loadLatestHandoff } from '../handoffs.js';
import { updateStats } from '../index-and-stats.js';
import { auditHighIdAt, revokeKeyAt } from '../key-audit.js';
import { createKeyAt, createSelfKeyAt } from '../key-writes.js';
import { onHandle } from '../open.js';
import type {
  ContextReads, ContinuityBlock, HippoStore, KeyAudit, KeyWrites, RecallWrites, StoreGroups, VectorReads,
} from '../port.js';
import { loadRecallSearchEntries, loadVectorCandidateEntries } from '../search-rows.js';
import { type ContinuityKey, listSessionEvents, loadActiveTaskSnapshot } from '../sessions.js';
import { entriesWithoutVectorAt, writeVectorsAt } from '../vector-writes.js';

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
