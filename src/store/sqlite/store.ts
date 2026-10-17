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
import { sqliteCards } from './cards-group.js';
import { sqliteConflicts } from './conflicts-group.js';
import { sqliteDormant } from './dormant-group.js';
import { sqliteGoals } from './goals-group.js';
import { sqliteReports } from './reports-group.js';
import { sqliteSessions } from './sessions-group.js';
import { sqliteConnectorEvents } from './connector-events-group.js';
import { sqliteConnectorWrites } from './connector-writes-group.js';
import { sqliteConsolidation } from './consolidation-group.js';
import { sqliteLearning } from './learning-group.js';
import { sqlitePromotion } from './promotion-group.js';
import { sqliteSharing } from './sharing-group.js';
import { sqliteDagReads } from './dag-reads-group.js';
import { sqliteEntryWrites } from './entry-writes-group.js';
import {
  sqliteAuditMaintenance,
  sqliteLessonWrites,
} from './maintenance-groups.js';
import { finishRecallAt, sqliteLastRecall } from './last-recall-group.js';
import { sqliteGraphReads } from './graph-reads-group.js';
import { sqliteObjects } from './objects-group.js';
import { sqlitePredictions } from './predictions-group.js';
import { sqliteQuarantine } from './quarantine-group.js';
import { sqliteVectorReads } from './vector-reads-group.js';
import { loadLatestHandoff } from '../handoffs.js';
import { updateStats } from '../index-and-stats.js';
import { flushStatsMirrors } from '../mirrors.js';
import { auditHighIdAt, revokeKeyAt } from '../key-audit.js';
import { changeScopeGrantAt, createKeyAt, createSelfKeyAt } from '../key-writes.js';
import { onHandle } from '../open.js';
import {
  type AuditLog, type AuditMaintenance, type ConnectorEvents, type ConnectorWrites, type ContextReads,
  type ContinuityBlock, type DagReads, type EntryWrites, type GraphReads, type HippoStore, type KeyAudit,
  type KeyGrants, type KeyWrites, type LastRecall, type LessonWrites, type Objects, type Predictions, type Quarantine,
  type Readiness, type StoreGroups, type StoreReach, type Sync, type VectorViews, type VectorWrites,
  hasGroup,
} from '../port.js';
import type { Cards, Conflicts, Dormant, Goals, Reports, Sessions } from '../port-groups.js';
import { served } from './served.js';
import { isSharedStore } from '../../core/config.js';
import { isGlobalStoreRoot, isInitialized, resolveGlobalRootDir } from '../../core/project-identity.js';
import { loadRecallEntries } from '../search-rows.js';
import { type ContinuityKey, listSessionEvents, loadActiveTaskSnapshot } from '../sessions.js';
import { entriesWithoutVectorAt, loadStoredVectorViews, writeVectorsAt } from '../vector-index.js';

/** `ctx` with its store filled: the one it carries, else hippo.db under its root. */
export function withStore<C extends { readonly hippoRoot: string; readonly store?: HippoStore }>(
  ctx: C,
): C & { readonly store: HippoStore } {
  return { ...ctx, store: ctx.store ?? sqliteStore(ctx.hippoRoot) };
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
      sharing: sqliteSharing(hippoRoot),
      globalStore: () => sqliteStore(resolveGlobalRootDir()),
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
  return { ...reach, global: { root: globalRoot, store: sqliteStore(globalRoot) } };
}

/** `sqliteSyncStore` as a served store: each method runs at once and answers through a Promise, so a throw rejects as
 * another store's would. */
export function sqliteStore(hippoRoot: string): HippoStore & StoreGroups {
  const sync = sqliteSyncStore(hippoRoot);
  return {
    ...served<ServedBaseMethods>(baseMethodsOf(sync)),
    localFiles: sync.localFiles,
    vectors: sqliteVectorReads(hippoRoot),
    vectorViews: served<VectorViews>(sync.vectorViews),
    keyAudit: served<KeyAudit>(sync.keyAudit),
    keyWrites: served<KeyWrites>(sync.keyWrites),
    keyGrants: served<KeyGrants>(sync.keyGrants),
    vectorWrites: served<VectorWrites>(sync.vectorWrites),
    entryWrites: served<EntryWrites>(sync.entryWrites),
    contextReads: served<ContextReads>(sync.contextReads),
    predictions: served<Predictions>(sync.predictions),
    dagReads: served<DagReads>(sync.dagReads),
    auditLog: served<AuditLog>(sync.auditLog),
    quarantine: served<Quarantine>(sync.quarantine),
    graphReads: served<GraphReads>(sync.graphReads),
    connectorWrites: served<ConnectorWrites>(sync.connectorWrites),
    connectorEvents: served<ConnectorEvents>(sync.connectorEvents),
    objects: served<Objects>(sqliteObjects(hippoRoot)),
    readiness: served<Readiness>(sync.readiness),
    lastRecall: served<LastRecall>(sync.lastRecall),
    auditMaintenance: served<AuditMaintenance>(sync.auditMaintenance),
    lessonWrites: served<LessonWrites>(sync.lessonWrites),
    sessions: served<Sessions>(sync.sessions),
    cards: served<Cards>(sync.cards),
    goals: served<Goals>(sync.goals),
    conflicts: served<Conflicts>(sync.conflicts),
    dormant: served<Dormant>(sync.dormant),
    reports: served<Reports>(sync.reports),
    close: async () => sync.close(),
  };
}

type ServedBaseMethods = Pick<
  HippoStore,
  | 'kind' | 'findApiKey' | 'searchRecallEntries' | 'entriesByIds' | 'activeGoals' | 'freshRawEntries' | 'continuity'
  | 'planningFallacyEvidence' | 'appendAuditEvents' | 'finishRecall' | 'bumpRecallStats' | 'recordTokens'
>;

function baseMethodsOf(sync: SqliteSyncStore): Sync<ServedBaseMethods> {
  const { kind, findApiKey, searchRecallEntries, entriesByIds, activeGoals, freshRawEntries, continuity,
    planningFallacyEvidence, appendAuditEvents, finishRecall, bumpRecallStats, recordTokens } = sync;
  return { kind, findApiKey, searchRecallEntries, entriesByIds, activeGoals, freshRawEntries, continuity,
    planningFallacyEvidence, appendAuditEvents, finishRecall, bumpRecallStats, recordTokens };
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
