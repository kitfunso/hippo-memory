// The built-in SQLite adapter behind the store port.
import { loadAmbientTalliesAt } from '../ambient.js';
import { listApiKeyRows, readApiKeyRecord } from '../auth.js';
import { existsSync } from 'node:fs';
import { appendAuditEvent, listAuditEventsAfter, queryAuditEvents } from '../audit.js';
import { getHippoDbPath, withWriteScope } from '../../db/index.js';
import { activeGoalsWithPoliciesAt } from '../goals.js';
import { planningFallacyEvidenceAt } from '../planning-fallacy-evidence.js';
import { recordTokenUse } from '../token-ledger.js';
import {
  loadAmbientCandidatesAt, loadContextCandidatesAt, newestEntriesAt, schemaFitAt,
} from '../candidates.js';
import {
  liveContentsBySourceAndTagAt, loadEntriesByIdsAt, loadFreshRawMemoriesAt, rawRowsUnderRefAt,
} from '../entry-reads.js';
import { sqliteAgentImport } from './agent-import.js';
import { sqliteCaptures } from './captures-group.js';
import { sqliteCompactionHooks } from './compaction-hooks-group.js';
import { sqliteCards } from './cards-group.js';
import { sqliteConflicts } from './conflicts-group.js';
import { sqliteDormant } from './dormant-group.js';
import { sqliteGoals } from './goals-group.js';
import { sqliteRejections } from './rejections-group.js';
import { sqliteFailureLog } from './failure-log-group.js';
import { sqliteCompactions } from './compactions-group.js';
import { sqliteReports } from './reports-group.js';
import { sqliteSessions } from './sessions-group.js';
import { sqliteConnectorEvents } from './connector-events-group.js';
import { sqliteConnectorWrites } from './connector-writes-group.js';
import { sqliteConsolidation } from './consolidation-group.js';
import { sqliteLearning } from './learning-group.js';
import { sqlitePromotion } from './promotion-group.js';
import { sqliteProjectTags } from './project-tags-group.js';
import { sqliteSharing } from './sharing-group.js';
import { sqliteDiagnostics } from './diagnostics-group.js';
import { sqliteEmbeddingIndex } from './embedding-index-group.js';
import { sqliteGraphRebuild } from './graph-rebuild-group.js';
import { sqliteLedger } from './ledger-group.js';
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
import { loadLatestHandoffAt } from '../handoffs.js';
import { updateStatsAt } from '../index-and-stats.js';
import { flushStatsMirrors } from '../mirrors.js';
import { auditHighIdAt, revokeKeyAt } from '../key-audit.js';
import { changeScopeGrantAt, createKeyAt, createSelfKeyAt } from '../key-writes.js';
import { type Handles, handlesOf, type OnHandle, openStore } from '../open.js';
import {
  type AuditLog, type AuditMaintenance, type ConnectorEvents, type ConnectorWrites, type ContextReads,
  type ContinuityBlock, type DagReads, type EntryWrites, type GraphReads, type HippoStore, type KeyAudit,
  type KeyGrants, type KeyWrites, type LastRecall, type LessonWrites, type Objects, type Predictions, type Quarantine,
  type Readiness, type StoreGroups, type StoreReach, type Sync, type VectorViews, type VectorWrites,
  hasGroup,
} from '../port.js';
import type { Cards, Conflicts, Dormant, Goals, Reports, Sessions } from '../port-groups.js';
import type { Rejections } from '../port/rejections.js';
import type { FailureLog } from '../port/failure-log.js';
import type { Compactions } from '../port/compactions.js';
import type { LocalFiles } from '../port/local-files.js';
import { served } from './served.js';
import { isSharedStore } from '../../core/config.js';
import { isGlobalStoreRoot, isInitialized, resolveGlobalRootDir } from '../../core/project-identity.js';
import { loadRecallEntriesAt } from '../search-rows.js';
import { type ContinuityKey, listSessionEventsAt, loadActiveTaskSnapshotAt } from '../sessions.js';
import { entriesWithoutVectorAt, loadStoredVectorViewsAt, writeVectorsAt } from '../vector-index.js';

/** Not on the synchronous store: the nearest-row scan yields to
 * the event loop, so this group answers only through Promises. */
type AsyncOnly = 'vectors';

/** The port as hippo.db answers it: each call runs to its end
 * and returns the value, so no write scope spans an await. */
// LocalFiles is written synchronous already, and Sync would erase its plain methods.
export type SqliteSyncStore = Sync<Omit<HippoStore, AsyncOnly | 'localFiles'>> & Pick<HippoStore, 'localFiles'>;

function sqliteLocalFiles(handles: Handles): LocalFiles {
  const { on } = handles;
  return {
    hippoRoot: handles.files.hippoRoot,
    consolidation: sqliteConsolidation(handles),
    agentImport: sqliteAgentImport,
    captures: sqliteCaptures(on),
    compactionHooks: sqliteCompactionHooks(on),
    promotion: sqlitePromotion(handles),
    projectTags: sqliteProjectTags(on),
    learning: sqliteLearning(on),
    sharing: sqliteSharing(on),
    diagnostics: sqliteDiagnostics(on),
    graphRebuild: sqliteGraphRebuild(on),
    embeddingIndex: sqliteEmbeddingIndex(on),
    ledger: sqliteLedger(on),
    globalStore: () => sqliteStore(resolveGlobalRootDir()),
  };
}

/** The built-in store: hippo.db under the port's own method names, each call on its own short-lived handles, so close
 * has nothing to release. */
export function sqliteSyncStore(
  hippoRoot: string,
): SqliteSyncStore & Sync<Omit<StoreGroups, AsyncOnly | 'localFiles'>> & Pick<StoreGroups, 'localFiles'> {
  const handles = handlesOf(hippoRoot);
  const { on } = handles;
  return {
    kind: 'sqlite',
    localFiles: sqliteLocalFiles(handles),
    ...sqliteBaseReads(on),
    ...sqliteRecallWrites(on),
    keyAudit: sqliteKeyAudit(on),
    keyWrites: sqliteKeyWrites(on),
    keyGrants: sqliteKeyGrants(on),
    vectorViews: sqliteVectorViews(on),
    vectorWrites: sqliteVectorWrites(on),
    entryWrites: sqliteEntryWrites(on),
    contextReads: sqliteContextReads(on),
    predictions: sqlitePredictions(on),
    dagReads: sqliteDagReads(on),
    auditLog: sqliteAuditLog(on),
    quarantine: sqliteQuarantine(on),
    graphReads: sqliteGraphReads(on),
    connectorWrites: sqliteConnectorWrites(on),
    connectorEvents: sqliteConnectorEvents(on),
    objects: sqliteObjects(on),
    readiness: sqliteReadiness(hippoRoot, on),
    lastRecall: sqliteLastRecall(on),
    auditMaintenance: sqliteAuditMaintenance(handles),
    lessonWrites: sqliteLessonWrites(handles),
    sessions: sqliteSessions(on),
    cards: sqliteCards(on),
    goals: sqliteGoals(on),
    conflicts: sqliteConflicts(on),
    dormant: sqliteDormant(on),
    reports: sqliteReports(on),
    rejections: sqliteRejections(on),
    failureLog: sqliteFailureLog(on),
    compactions: sqliteCompactions(on),
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

function sqliteBaseReads(on: OnHandle): SqliteBaseReads {
  return {
    findApiKey: (keyId) => on((db) => readApiKeyRecord(db, keyId)),
    searchRecallEntries: (query, args) => on((db) => loadRecallEntriesAt(db, query, args), openStore),
    entriesByIds: (ids, tenantId) => on((db) => loadEntriesByIdsAt(db, ids, tenantId), openStore),
    activeGoals: (opts) => on((db) => activeGoalsWithPoliciesAt(db, opts)),
    freshRawEntries: (count, tenantId, sessionId, origins) =>
      on((db) => loadFreshRawMemoriesAt(db, count, tenantId, sessionId, origins ?? undefined), openStore),
    continuity: (tenantId, eventLimit, key) => continuityAt(on, tenantId, eventLimit, key),
    planningFallacyEvidence: (tenantId, classQueryTokens) =>
      on((db) => planningFallacyEvidenceAt(db, tenantId, classQueryTokens)),
  };
}

type SqliteRecallWrites = Pick<
  SqliteSyncStore,
  'appendAuditEvents' | 'finishRecall' | 'bumpRecallStats' | 'recordTokens'
>;

function sqliteRecallWrites(on: OnHandle): SqliteRecallWrites {
  return {
    appendAuditEvents(events) {
      if (events.length === 0) return;
      on((db) => withWriteScope(db, 'append_audit_events', () => {
        for (const event of events) appendAuditEvent(db, event);
      }));
    },
    finishRecall(writes) {
      on((db) => finishRecallAt(db, writes));
    },
    bumpRecallStats(recalled) {
      on((db, files) => updateStatsAt(db, files, { recalled }), openStore);
    },
    recordTokens(use) {
      on((db) => recordTokenUse(db, use));
    },
  };
}

function sqliteVectorViews(on: OnHandle): Sync<VectorViews> {
  return {
    storedVectorViews: (ids) => on((db) => loadStoredVectorViewsAt(db, ids)),
  };
}

function sqliteVectorWrites(on: OnHandle): Sync<VectorWrites> {
  return {
    entriesWithoutVector: (query) => on((db) => entriesWithoutVectorAt(db, query)),
    writeVectors: (write) => on((db) => writeVectorsAt(db, write)),
  };
}

function sqliteAuditLog(on: OnHandle): Sync<AuditLog> {
  return {
    listAuditEvents: (query) => on((db) => queryAuditEvents(db, query)),
  };
}

function sqliteReadiness(hippoRoot: string, on: OnHandle): Sync<Readiness> {
  return {
    ping() {
      // A probe must not create the store; the first write does, so a root with none yet is ready.
      if (!existsSync(getHippoDbPath(hippoRoot))) return;
      on((db) => { db.prepare('SELECT 1').get(); });
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
  const handles = handlesOf(hippoRoot);
  const sync = sqliteSyncStore(hippoRoot);
  return {
    ...served<ServedBaseMethods>(baseMethodsOf(sync)),
    localFiles: sync.localFiles,
    vectors: sqliteVectorReads(handles),
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
    objects: served<Objects>(sqliteObjects(handles.on)),
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
    rejections: served<Rejections>(sync.rejections),
    failureLog: served<FailureLog>(sync.failureLog),
    compactions: served<Compactions>(sync.compactions),
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

function sqliteContextReads(on: OnHandle): Sync<ContextReads> {
  return {
    unfinishedHandoff: (tenantId, maxAgeMs, key) =>
      on((db) => loadLatestHandoffAt(
        db,
        tenantId,
        undefined,
        { unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' },
        key ?? undefined,
      ), openStore),
    ambientCandidates: (tenantId, { recentNeeded, admit, recall, origins }) =>
      on((db) => loadAmbientCandidatesAt(db, tenantId, recentNeeded, admit, recall, origins), openStore),
    contextCandidates: (tenantId, filter) => on((db) => loadContextCandidatesAt(db, tenantId, filter), openStore),
    ambientTallies: (tenantId, filter) => on((db) => loadAmbientTalliesAt(db, tenantId, filter), openStore),
    newestEntries: (tenantId, limit) => on((db) => newestEntriesAt(db, tenantId, limit), openStore),
    schemaFit: (tenantId, content, tags) => on((db) => schemaFitAt(db, tenantId, content, tags), openStore),
    liveContentsBySourceAndTag: (tenantId, source, tag, exceptSessionId) =>
      on((db) => liveContentsBySourceAndTagAt(db, tenantId, source, tag, exceptSessionId), openStore),
    rawRowsUnderRef: (tenantId, refPrefix) => on((db) => rawRowsUnderRefAt(db, tenantId, refPrefix), openStore),
  };
}

function sqliteKeyWrites(on: OnHandle): Sync<KeyWrites> {
  return {
    createApiKey(mint) {
      on((db) => createKeyAt(db, mint));
    },
    createSelfApiKey: (mint) => on((db) => createSelfKeyAt(db, mint)),
    listApiKeys: (query) => on((db) => listApiKeyRows(db, query)),
  };
}

function sqliteKeyGrants(on: OnHandle): Sync<KeyGrants> {
  return {
    changeScopeGrant(change) {
      on((db) => changeScopeGrantAt(db, change));
    },
  };
}

function sqliteKeyAudit(on: OnHandle): Sync<KeyAudit> {
  return {
    revokeApiKey: (revoke) => on((db) => revokeKeyAt(db, revoke)),
    auditEventsAfter: (opts) => on((db) => listAuditEventsAfter(db, opts)),
    auditHighId: () => on(auditHighIdAt),
  };
}

/** sqliteStore's continuity read, for the synchronous recall that cannot await the port. */
function continuityAt(
  on: OnHandle,
  tenantId: string,
  eventLimit: number,
  key: ContinuityKey | null,
): ContinuityBlock {
  return on((db, files) => {
    const activeSnapshot = loadActiveTaskSnapshotAt(db, files, tenantId, key ?? undefined);
    const sessionId = activeSnapshot?.session_id ?? undefined;
    return {
      activeSnapshot,
      sessionHandoff: sessionId ? loadLatestHandoffAt(db, tenantId, sessionId, {}, key ?? undefined) : null,
      recentSessionEvents: sessionId
        ? listSessionEventsAt(db, tenantId, { session_id: sessionId, limit: eventLimit })
        : [],
    };
  }, openStore);
}
