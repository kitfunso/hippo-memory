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
  ContextReads, ContinuityBlock, HippoStore, KeyAudit, KeyWrites, RecallWrites, StoreGroups, Sync, VectorReads,
} from '../port.js';
import { loadRecallSearchEntries, loadVectorCandidateEntries } from '../search-rows.js';
import { type ContinuityKey, listSessionEvents, loadActiveTaskSnapshot } from '../sessions.js';
import { entriesWithoutVectorAt, writeVectorsAt } from '../vector-writes.js';

/** The store a request runs on: the served one, else hippo.db under its root, as the CLI and SDK callers have it. */
export function storeFor(ctx: { readonly hippoRoot: string; readonly store?: HippoStore }): HippoStore {
  return ctx.store ?? sqliteStore(ctx.hippoRoot);
}

/** Not on the synchronous store: the nearest-row scan yields to the event loop, so this group answers only through Promises. */
type AsyncOnly = 'vectors';

/** The port as hippo.db answers it: each call runs to its end and returns the value, so no write scope spans an await. */
export type SqliteSyncStore = Sync<Omit<HippoStore, AsyncOnly>>;

/** The built-in store: hippo.db under the port's own method names, each call on its own short-lived handles, so close has nothing to release. */
export function sqliteSyncStore(hippoRoot: string): SqliteSyncStore & Sync<Omit<StoreGroups, AsyncOnly>> {
  return {
    kind: 'sqlite',
    findApiKey(keyId) {
      return onHandle(hippoRoot, (db) => readApiKeyRecord(db, keyId));
    },
    searchRecallEntries(query, args) {
      return loadRecallSearchEntries(
        hippoRoot, query, args.limit, args.tenantId, args.requestedScope, args.explicitScopeMode, args.includeSuperseded, args.originProjects, args.ownScope,
      );
    },
    entriesByIds(ids, tenantId) {
      return loadEntriesByIds(hippoRoot, ids, tenantId);
    },
    activeGoals(opts) {
      return activeGoalsWithPolicies(hippoRoot, opts);
    },
    freshRawEntries(count, tenantId, sessionId, origins) {
      return loadFreshRawMemories(hippoRoot, count, tenantId, sessionId, origins ?? undefined);
    },
    continuity(tenantId, eventLimit, key) {
      return continuityAt(hippoRoot, tenantId, eventLimit, key);
    },
    planningFallacyEvidence(tenantId, classQueryTokens) {
      return planningFallacyEvidenceAt(hippoRoot, tenantId, classQueryTokens);
    },
    appendAuditEvents(events) {
      if (events.length === 0) return;
      onHandle(hippoRoot, (db) => withWriteScope(db, 'append_audit_events', () => {
        for (const event of events) appendAuditEvent(db, event);
      }));
    },
    finishRecall(writes) {
      finishRecallAt(hippoRoot, writes);
    },
    bumpRecallStats(recalled) {
      updateStats(hippoRoot, { recalled });
    },
    recordTokens(use) {
      onHandle(hippoRoot, (db) => recordTokenUse(db, use));
    },
    keyAudit: sqliteKeyAudit(hippoRoot),
    keyWrites: sqliteKeyWrites(hippoRoot),
    vectorWrites: {
      entriesWithoutVector(query) {
        return onHandle(hippoRoot, (db) => entriesWithoutVectorAt(db, query));
      },
      writeVectors(write) {
        return onHandle(hippoRoot, (db) => writeVectorsAt(db, write));
      },
    },
    entryWrites: sqliteEntryWrites(hippoRoot),
    contextReads: sqliteContextReads(hippoRoot),
    close() {},
  };
}

/** `sqliteSyncStore` as a served store: each method runs at once and answers through a Promise, so a throw rejects as another store's would. */
export function sqliteStore(hippoRoot: string): HippoStore & StoreGroups {
  const sync = sqliteSyncStore(hippoRoot);
  const { keyAudit, keyWrites, vectorWrites, entryWrites, contextReads } = sync;
  return {
    kind: sync.kind,
    findApiKey: async (keyId) => sync.findApiKey(keyId),
    searchRecallEntries: async (query, args) => sync.searchRecallEntries(query, args),
    entriesByIds: async (ids, tenantId) => sync.entriesByIds(ids, tenantId),
    activeGoals: async (opts) => sync.activeGoals(opts),
    freshRawEntries: async (count, tenantId, sessionId, origins) => sync.freshRawEntries(count, tenantId, sessionId, origins),
    continuity: async (tenantId, eventLimit, key) => sync.continuity(tenantId, eventLimit, key),
    planningFallacyEvidence: async (tenantId, classQueryTokens) => sync.planningFallacyEvidence(tenantId, classQueryTokens),
    appendAuditEvents: async (events) => sync.appendAuditEvents(events),
    finishRecall: async (writes) => sync.finishRecall(writes),
    bumpRecallStats: async (recalled) => sync.bumpRecallStats(recalled),
    recordTokens: async (use) => sync.recordTokens(use),
    vectors: sqliteVectorReads(hippoRoot),
    keyAudit: {
      revokeApiKey: async (revoke) => keyAudit.revokeApiKey(revoke),
      auditEventsAfter: async (opts) => keyAudit.auditEventsAfter(opts),
      auditHighId: async () => keyAudit.auditHighId(),
    },
    keyWrites: {
      createApiKey: async (mint) => keyWrites.createApiKey(mint),
      createSelfApiKey: async (mint) => keyWrites.createSelfApiKey(mint),
      listApiKeys: async (query) => keyWrites.listApiKeys(query),
    },
    vectorWrites: {
      entriesWithoutVector: async (query) => vectorWrites.entriesWithoutVector(query),
      writeVectors: async (write) => vectorWrites.writeVectors(write),
    },
    entryWrites: {
      writeEntry: async (write) => entryWrites.writeEntry(write),
      applyOutcome: async (outcome) => entryWrites.applyOutcome(outcome),
      supersede: async (write) => entryWrites.supersede(write),
      archiveRaw: async (archive) => entryWrites.archiveRaw(archive),
      forget: async (removal) => entryWrites.forget(removal),
    },
    contextReads: {
      unfinishedHandoff: async (tenantId, maxAgeMs, key) => contextReads.unfinishedHandoff(tenantId, maxAgeMs, key),
      ambientCandidates: async (tenantId, request) => contextReads.ambientCandidates(tenantId, request),
      contextCandidates: async (tenantId, filter) => contextReads.contextCandidates(tenantId, filter),
      ambientTallies: async (tenantId, filter) => contextReads.ambientTallies(tenantId, filter),
    },
    close: async () => sync.close(),
  };
}

function sqliteVectorReads(hippoRoot: string): VectorReads {
  return {
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
  };
}

function sqliteContextReads(hippoRoot: string): Sync<ContextReads> {
  return {
    unfinishedHandoff(tenantId, maxAgeMs, key) {
      return loadLatestHandoff(hippoRoot, tenantId, undefined, { unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' }, key ?? undefined);
    },
    ambientCandidates(tenantId, { recentNeeded, admit, recall, origins }) {
      return loadAmbientCandidates(hippoRoot, tenantId, recentNeeded, admit, recall, origins);
    },
    contextCandidates(tenantId, filter) {
      return loadContextCandidates(hippoRoot, tenantId, filter);
    },
    ambientTallies(tenantId, filter) {
      return loadAmbientTallies(hippoRoot, tenantId, filter);
    },
  };
}

function sqliteKeyWrites(hippoRoot: string): Sync<KeyWrites> {
  return {
    createApiKey(mint) {
      onHandle(hippoRoot, (db) => createKeyAt(db, mint));
    },
    createSelfApiKey(mint) {
      return onHandle(hippoRoot, (db) => createSelfKeyAt(db, mint));
    },
    listApiKeys(query) {
      return onHandle(hippoRoot, (db) => listApiKeyRows(db, query));
    },
  };
}

function sqliteKeyAudit(hippoRoot: string): Sync<KeyAudit> {
  return {
    revokeApiKey(revoke) {
      return onHandle(hippoRoot, (db) => revokeKeyAt(db, revoke));
    },
    auditEventsAfter(opts) {
      return onHandle(hippoRoot, (db) => listAuditEventsAfter(db, opts));
    },
    auditHighId() {
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
