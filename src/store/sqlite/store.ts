// The built-in SQLite adapter behind the store port.
import { loadAmbientTallies } from '../ambient.js';
import { listApiKeyRows, readApiKeyRecord } from '../auth.js';
import { existsSync } from 'node:fs';
import { appendAuditEvent, listAuditEventsAfter, queryAuditEvents } from '../audit.js';
import { getHippoDbPath, withWriteScope } from '../../db/index.js';
import { activeGoalsWithPolicies } from '../goals.js';
import { planningFallacyEvidenceAt } from '../planning-fallacy-evidence.js';
import { recordTokenUse } from '../token-ledger.js';
import { loadAmbientCandidates, loadContextCandidates } from '../candidates.js';
import { loadEntriesByIds, loadFreshRawMemories } from '../entry-reads.js';
import { sqliteAgentImport } from './agent-import.js';
import { servedCards, sqliteCards } from './cards-group.js';
import { servedConflicts, sqliteConflicts } from './conflicts-group.js';
import { servedDormant, sqliteDormant } from './dormant-group.js';
import { servedGoals, sqliteGoals } from './goals-group.js';
import { servedReports, sqliteReports } from './reports-group.js';
import { servedSessions, sqliteSessions } from './sessions-group.js';
import { servedConnectorEvents, sqliteConnectorEvents } from './connector-events-group.js';
import { servedConnectorWrites, sqliteConnectorWrites } from './connector-writes-group.js';
import { sqliteConsolidation } from './consolidation-group.js';
import { sqliteLearning } from './learning-group.js';
import { sqlitePromotion } from './promotion-group.js';
import { sqliteDagReads } from './dag-reads-group.js';
import { sqliteEntryWrites } from './entry-writes-group.js';
import {
  servedAuditMaintenance,
  servedLessonWrites,
  sqliteAuditMaintenance,
  sqliteLessonWrites,
} from './maintenance-groups.js';
import { finishRecallAt, servedLastRecall, sqliteLastRecall } from './last-recall-group.js';
import { servedGraphReads, sqliteGraphReads } from './graph-reads-group.js';
import { servedObjects, sqliteObjects } from './objects-group.js';
import { servedPredictions, sqlitePredictions } from './predictions-group.js';
import { servedQuarantine, sqliteQuarantine } from './quarantine-group.js';
import { sqliteVectorReads } from './vector-reads-group.js';
import { loadLatestHandoff } from '../handoffs.js';
import { updateStats } from '../index-and-stats.js';
import { flushStatsMirrors } from '../mirrors.js';
import { auditHighIdAt, revokeKeyAt } from '../key-audit.js';
import { changeScopeGrantAt, createKeyAt, createSelfKeyAt } from '../key-writes.js';
import { onHandle } from '../open.js';
import { narrowStore, type StoreWith } from '../narrow.js';
import {
  type AuditLog, type ContextReads, type ContinuityBlock, type HippoStore, type KeyAudit, type KeyGrants,
  type KeyWrites, type Readiness, type StoreGroup, type StoreGroups, type StoreReach, type Sync, type VectorViews,
  type VectorWrites, hasGroup,
} from '../port.js';
import { isSharedStore } from '../../core/config.js';
import { isGlobalStoreRoot, isInitialized, resolveGlobalRootDir } from '../../core/project-identity.js';
import type { SessionAndAdminGroups } from '../port-groups.js';
import { loadRecallEntries } from '../search-rows.js';
import { type ContinuityKey, listSessionEvents, loadActiveTaskSnapshot } from '../sessions.js';
import { entriesWithoutVectorAt, loadStoredVectorViews, writeVectorsAt } from '../vector-index.js';

/** `ctx` with its store filled (the one it carries, else hippo.db under its root) and its groups proven,
 * so a public entry given a store without them still answers 501. */
export function withStoreGroups<
  C extends { readonly hippoRoot: string; readonly store?: HippoStore },
  G extends StoreGroup,
>(
  ctx: C,
  ...groups: readonly [G, ...G[]]
): C & { readonly store: StoreWith<G> } {
  return { ...ctx, store: narrowStore(ctx.store ?? sqliteStore(ctx.hippoRoot), ...groups) };
}

/** Not on the synchronous store: the nearest-row scan yields to
 * the event loop, so this group answers only through Promises. */
type AsyncOnly = 'vectors';

/** The port as hippo.db answers it: each call runs to its end
 * and returns the value, so no write scope spans an await. */
// LocalFiles is written synchronous already, and Sync would erase its plain methods.
export type SqliteSyncStore = Sync<Omit<HippoStore, AsyncOnly | 'localFiles'>> & Pick<HippoStore, 'localFiles'>;

/** The built-in store: hippo.db under the port's own method names, each call on its own short-lived handles, so close
 * has nothing to release. */
export function sqliteSyncStore(
  hippoRoot: string,
): SqliteSyncStore & Sync<Omit<StoreGroups, AsyncOnly | 'localFiles'>> & Pick<StoreGroups, 'localFiles'> {
  return {
    kind: 'sqlite',
    localFiles: {
      hippoRoot,
      consolidation: sqliteConsolidation(hippoRoot),
      agentImport: sqliteAgentImport,
      promotion: sqlitePromotion(hippoRoot),
      learning: sqliteLearning(hippoRoot),
    },
    ...sqliteBaseReads(hippoRoot),
    ...sqliteRecallWrites(hippoRoot),
    keyAudit: sqliteKeyAudit(hippoRoot),
    keyWrites: sqliteKeyWrites(hippoRoot),
    keyGrants: sqliteKeyGrants(hippoRoot),
    vectorViews: sqliteVectorViews(hippoRoot),
    vectorWrites: sqliteVectorWrites(hippoRoot),
    entryWrites: sqliteEntryWrites(hippoRoot),
    contextReads: sqliteContextReads(hippoRoot),
    predictions: sqlitePredictions(hippoRoot),
    dagReads: sqliteDagReads(hippoRoot),
    auditLog: sqliteAuditLog(hippoRoot),
    quarantine: sqliteQuarantine(hippoRoot),
    graphReads: sqliteGraphReads(hippoRoot),
    connectorWrites: sqliteConnectorWrites(hippoRoot),
    connectorEvents: sqliteConnectorEvents(hippoRoot),
    objects: sqliteObjects(hippoRoot),
    readiness: sqliteReadiness(hippoRoot),
    lastRecall: sqliteLastRecall(hippoRoot),
    auditMaintenance: sqliteAuditMaintenance(hippoRoot),
    lessonWrites: sqliteLessonWrites(hippoRoot),
    sessions: sqliteSessions(hippoRoot),
    cards: sqliteCards(hippoRoot),
    goals: sqliteGoals(hippoRoot),
    conflicts: sqliteConflicts(hippoRoot),
    dormant: sqliteDormant(hippoRoot),
    reports: sqliteReports(hippoRoot),
    close() {
      flushStatsMirrors(hippoRoot);
    },
  };
}

type SqliteBaseReads = Pick<
  SqliteSyncStore,
  | 'findApiKey'
  | 'searchRecallEntries'
  | 'entriesByIds'
  | 'activeGoals'
  | 'freshRawEntries'
  | 'continuity'
  | 'planningFallacyEvidence'
>;

function sqliteBaseReads(hippoRoot: string): SqliteBaseReads {
  return {
    findApiKey(keyId) {
      return onHandle(hippoRoot, (db) => readApiKeyRecord(db, keyId));
    },
    searchRecallEntries(query, args) {
      return loadRecallEntries(hippoRoot, query, args);
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
  };
}

type SqliteRecallWrites = Pick<
  SqliteSyncStore,
  'appendAuditEvents' | 'finishRecall' | 'bumpRecallStats' | 'recordTokens'
>;

function sqliteRecallWrites(hippoRoot: string): SqliteRecallWrites {
  return {
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
  };
}

function sqliteVectorViews(hippoRoot: string): Sync<VectorViews> {
  return {
    storedVectorViews(ids) {
      return loadStoredVectorViews(hippoRoot, ids);
    },
  };
}

function sqliteVectorWrites(hippoRoot: string): Sync<VectorWrites> {
  return {
    entriesWithoutVector(query) {
      return onHandle(hippoRoot, (db) => entriesWithoutVectorAt(db, query));
    },
    writeVectors(write) {
      return onHandle(hippoRoot, (db) => writeVectorsAt(db, write));
    },
  };
}

function sqliteAuditLog(hippoRoot: string): Sync<AuditLog> {
  return {
    listAuditEvents(query) {
      return onHandle(hippoRoot, (db) => queryAuditEvents(db, query));
    },
  };
}

function sqliteReadiness(hippoRoot: string): Sync<Readiness> {
  return {
    ping() {
      // A probe must not create the store; the first write does, so a root with none yet is ready.
      if (!existsSync(getHippoDbPath(hippoRoot))) return;
      onHandle(hippoRoot, (db) => { db.prepare('SELECT 1').get(); });
    },
  };
}

/** The composition roots reach the request scope through the adapter's one entry. */
export { runDetachedSqliteRequest, runSqliteRequest } from './request-scope.js';

/** What a call on `store` reaches, probed as the api's own context plan did (`shared` is the transport's flag). */
export function sqliteReach(hippoRoot: string, store: HippoStore, shared?: boolean): StoreReach {
  const other = hasGroup(store, 'localFiles') ? undefined : store;
  const sharedStore = shared === true || isSharedStore(hippoRoot);
  const globalRoot = resolveGlobalRootDir();
  const canReadGlobal = !sharedStore && other === undefined && isInitialized(globalRoot);
  const reach: StoreReach = {
    hasLocal: other !== undefined || isInitialized(hippoRoot),
    isGlobal: isGlobalStoreRoot(hippoRoot),
    shared: sharedStore,
  };
  if (!canReadGlobal) return reach;
  return { ...reach, global: { root: globalRoot, store: narrowStore(sqliteStore(globalRoot), 'contextReads') } };
}

type SyncStoreGroups = ReturnType<typeof sqliteSyncStore>;

/** `sqliteSyncStore` as a served store: each method runs at once and answers through a Promise, so a throw rejects as
 * another store's would. */
export function sqliteStore(hippoRoot: string): HippoStore & StoreGroups {
  const sync = sqliteSyncStore(hippoRoot);
  return {
    ...servedBaseMethods(sync),
    localFiles: sync.localFiles,
    vectors: sqliteVectorReads(hippoRoot),
    vectorViews: { storedVectorViews: async (ids) => sync.vectorViews.storedVectorViews(ids) },
    ...servedKeyGroups(sync),
    ...servedEntryGroups(sync),
    predictions: servedPredictions(sync.predictions),
    ...servedDagAndAudit(sync),
    quarantine: servedQuarantine(sync.quarantine),
    graphReads: servedGraphReads(sync.graphReads),
    connectorWrites: servedConnectorWrites(sync.connectorWrites),
    connectorEvents: servedConnectorEvents(sync.connectorEvents),
    objects: servedObjects(sqliteObjects(hippoRoot)),
    readiness: { ping: async () => sync.readiness.ping() },
    lastRecall: servedLastRecall(sync.lastRecall),
    auditMaintenance: servedAuditMaintenance(sync.auditMaintenance),
    lessonWrites: servedLessonWrites(sync.lessonWrites),
    ...servedSessionAndAdminGroups(sync),
    close: async () => sync.close(),
  };
}

function servedSessionAndAdminGroups(sync: SyncStoreGroups): SessionAndAdminGroups {
  return {
    sessions: servedSessions(sync.sessions),
    cards: servedCards(sync.cards),
    goals: servedGoals(sync.goals),
    conflicts: servedConflicts(sync.conflicts),
    dormant: servedDormant(sync.dormant),
    reports: servedReports(sync.reports),
  };
}

type ServedBaseMethods = Pick<
  HippoStore,
  | 'kind' | 'findApiKey' | 'searchRecallEntries' | 'entriesByIds' | 'activeGoals' | 'freshRawEntries' | 'continuity'
  | 'planningFallacyEvidence' | 'appendAuditEvents' | 'finishRecall' | 'bumpRecallStats' | 'recordTokens'
>;

function servedBaseMethods(sync: SyncStoreGroups): ServedBaseMethods {
  return {
    kind: sync.kind,
    findApiKey: async (keyId) => sync.findApiKey(keyId),
    searchRecallEntries: async (query, args) => sync.searchRecallEntries(query, args),
    entriesByIds: async (ids, tenantId) => sync.entriesByIds(ids, tenantId),
    activeGoals: async (opts) => sync.activeGoals(opts),
    freshRawEntries: async (count, tenantId, sessionId, origins) =>
      sync.freshRawEntries(count, tenantId, sessionId, origins),
    continuity: async (tenantId, eventLimit, key) => sync.continuity(tenantId, eventLimit, key),
    planningFallacyEvidence: async (tenantId, classQueryTokens) =>
      sync.planningFallacyEvidence(tenantId, classQueryTokens),
    appendAuditEvents: async (events) => sync.appendAuditEvents(events),
    finishRecall: async (writes) => sync.finishRecall(writes),
    bumpRecallStats: async (recalled) => sync.bumpRecallStats(recalled),
    recordTokens: async (use) => sync.recordTokens(use),
  };
}

function servedKeyGroups(sync: SyncStoreGroups): Pick<StoreGroups, 'keyAudit' | 'keyWrites' | 'keyGrants'> {
  const { keyAudit, keyWrites, keyGrants } = sync;
  return {
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
    keyGrants: {
      changeScopeGrant: async (change) => keyGrants.changeScopeGrant(change),
    },
  };
}

function servedEntryGroups(sync: SyncStoreGroups): Pick<StoreGroups, 'vectorWrites' | 'entryWrites' | 'contextReads'> {
  const { vectorWrites, entryWrites, contextReads } = sync;
  return {
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
  };
}

function servedDagAndAudit(sync: SyncStoreGroups): Pick<StoreGroups, 'dagReads' | 'auditLog'> {
  const { dagReads, auditLog } = sync;
  return {
    dagReads: {
      sessionRawEntries: async (query) => dagReads.sessionRawEntries(query),
      sessionRawCount: async (query) => dagReads.sessionRawCount(query),
      summaryWithDescendants: async (tenantId, id, walk) => dagReads.summaryWithDescendants(tenantId, id, walk),
    },
    auditLog: {
      listAuditEvents: async (query) => auditLog.listAuditEvents(query),
    },
  };
}

function sqliteContextReads(hippoRoot: string): Sync<ContextReads> {
  return {
    unfinishedHandoff(tenantId, maxAgeMs, key) {
      return loadLatestHandoff(
        hippoRoot,
        tenantId,
        undefined,
        { unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' },
        key ?? undefined,
      );
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

function sqliteKeyGrants(hippoRoot: string): Sync<KeyGrants> {
  return {
    changeScopeGrant(change) {
      onHandle(hippoRoot, (db) => changeScopeGrantAt(db, change));
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
function continuityAt(
  hippoRoot: string,
  tenantId: string,
  eventLimit: number,
  key: ContinuityKey | null,
): ContinuityBlock {
  const activeSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId, key ?? undefined);
  const sessionId = activeSnapshot?.session_id ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? loadLatestHandoff(hippoRoot, tenantId, sessionId, {}, key ?? undefined) : null,
    recentSessionEvents: sessionId
      ? listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, limit: eventLimit })
      : [],
  };
}
