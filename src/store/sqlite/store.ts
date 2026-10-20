// The built-in SQLite adapter behind the store port.
import { loadAmbientTalliesAt } from './ambient.js';
import type { LossAversion } from '../../base/memory/memory.js';
import { ambientRefusal } from '../../base/scope/read-admission.js';
import { readApiKeyRecord } from './auth.js';
import { existsSync } from 'node:fs';
import { appendAuditEventsAt, queryAuditEvents } from './audit.js';
import { getHippoDbPath, type DatabaseSyncLike } from '../../db/index.js';
import { activeGoalsWithPoliciesAt, sqliteGoals } from './goals.js';
import { planningFallacyEvidenceAt } from './planning-fallacy-evidence.js';
import { sqlitePredictions } from './predictions.js';
import { recordTokenUse } from './token-ledger.js';
import { loadAmbientCandidatesAt, loadContextCandidatesAt, newestEntriesAt, schemaFitAt } from './candidates.js';
import {
  liveContentsBySourceAndTagAt,
  loadEntriesByIdsAt,
  loadFreshRawMemoriesAt,
  rawRowsUnderRefAt,
} from './entry-reads.js';
import { sqliteAgentImport } from './agent-import.js';
import { sqliteCaptures } from './captures.js';
import { sqliteCompactionHooks } from './compaction-hooks.js';
import { sqliteCards } from './cards.js';
import { sqliteConflicts } from './conflicts.js';
import { sqliteDormant } from './dormant.js';
import { sqliteRefusedAmong, sqliteRejections } from './rejections.js';
import { sqliteFailureLog } from './failure-log.js';
import { sqliteCompactions } from './compactions.js';
import { sqliteReports } from './reports.js';
import { sqliteSessions, listSessionEventsAt } from './sessions.js';
import { sqliteConnectorEvents } from './connector-events.js';
import { sqliteConnectorWrites } from './connector-writes.js';
import { sqliteConsolidation } from './consolidation.js';
import { sqliteLearning } from './learning.js';
import { sqlitePromotion } from './promotion.js';
import { sqliteProjectTags } from './project-tags.js';
import { sqliteImportKeys, sqliteSharing } from './sharing.js';
import { sqliteDiagnostics } from './diagnostics.js';
import { sqliteEmbeddingIndex } from './embedding-index.js';
import { sqliteGraphRebuild } from './graph-rebuild.js';
import { sqliteLedger } from './ledger.js';
import { sqliteFolderFiles } from './folder-files.js';
import { sqliteDagReads } from './dag-reads.js';
import { sqliteEntryWrites } from './entry-writes.js';
import { sqliteAuditMaintenance } from './audit-maintenance.js';
import { sqliteLessonWrites } from './lesson-writes.js';
import { finishRecallAt, sqliteLastRecall } from './last-recall.js';
import { sqliteGraphReads } from './graph-reads.js';
import { sqliteObjects } from './objects.js';
import { sqliteQuarantine } from './quarantine.js';
import { sqliteVectorReads } from './vector-reads.js';
import { loadLatestHandoffAt } from './handoffs.js';
import { updateStatsAt } from './index-and-stats.js';
import { flushHeldMirrors } from './mirrors.js';
import { sqliteKeyAudit, sqliteKeyGrants, sqliteKeyWrites } from './keys.js';
import type { Handles, OnHandle, StoreFiles } from './open.js';
import { handlesOf, openStore } from './handles.js';
import { bound, boundWithFiles, skipEmpty, type Bodies, type FileBodies } from './bound.js';
import {
  type AuditLog,
  type AuditMaintenance,
  type ConnectorEvents,
  type ConnectorWrites,
  type ContextReads,
  type ContinuityBlock,
  type DagReads,
  type EmbeddingIndex,
  type EntryWrites,
  type FolderFiles,
  type GraphReads,
  type HippoStore,
  type KeyAudit,
  type KeyGrants,
  type KeyWrites,
  type LastRecall,
  type Ledger,
  type LessonWrites,
  type Objects,
  type Predictions,
  type Promotion,
  type Quarantine,
  type Readiness,
  type Sharing,
  type StoreGroups,
  type StoreReach,
  type VectorViews,
  type VectorWrites,
} from '../port.js';
import type { Sync } from './served.js';
import type { Cards, Conflicts, Dormant, Goals, Reports, Sessions } from '../port-groups.js';
import type { Rejections } from '../port/rejections.js';
import type { FailureLog } from '../port/failure-log.js';
import type { Compactions } from '../port/compactions.js';
import type { LocalFiles } from '../local/local-files.js';
import type { Consolidation } from '../port/consolidation.js';
import type { Learning } from '../port/learning.js';
import type { Captures } from '../port/captures.js';
import type { CompactionHooks } from '../port/compaction-hooks.js';
import type { ProjectTags } from '../port/project-tags.js';
import type { Diagnostics } from '../port/diagnostics.js';
import type { GraphRebuild } from '../port/graph-rebuild.js';
import type { AgentImport } from '../port/agent-import.js';
import { served } from './served.js';
import { isSharedStore } from '../../base/config/config.js';
import { isGlobalStoreRoot, isInitialized, resolveGlobalRootDir } from '../../base/scope/project-identity.js';
import { loadRecallEntriesAt } from './search-rows.js';
import { loadActiveTaskSnapshotAt } from './task-snapshots.js';
import { entriesWithoutVectorAt, loadStoredVectorViewsAt, writeVectorsAt } from './vector-index.js';
import type { ContinuityKey } from '../port/types.js';
import { isLocalStore, type LocalStore } from '../local/index.js';

/** Not on the synchronous store: the nearest-row scan yields to the event loop, so this group answers only through
 * Promises. */
type AsyncOnly = 'vectors';

/**
 * The port as hippo.db answers it: each call runs to its end and returns the value, so no write scope spans an await.
 */
// LocalFiles is written synchronous already, and Sync would erase its plain methods.
export type SqliteSyncStore = Sync<Omit<HippoStore, AsyncOnly>> & Pick<LocalStore, 'localFiles'>;

type LocalGroups = Pick<
  StoreGroups,
  | 'consolidation'
  | 'learning'
  | 'captures'
  | 'compactionHooks'
  | 'projectTags'
  | 'diagnostics'
  | 'graphRebuild'
  | 'agentImport'
>;

/** The groups that read and write hippo.db's own files beside its rows. */
function sqliteLocalGroups(handles: Handles): LocalGroups {
  const { on } = handles;
  return {
    consolidation: sqliteConsolidation(handles),
    learning: sqliteLearning(on),
    captures: sqliteCaptures(on),
    compactionHooks: sqliteCompactionHooks(on),
    projectTags: sqliteProjectTags(on),
    diagnostics: sqliteDiagnostics(on),
    graphRebuild: sqliteGraphRebuild(on),
    agentImport: sqliteAgentImport(handles.files),
  };
}

function sqliteLocalFiles(handles: Handles, groups: LocalGroups): LocalFiles {
  const { on } = handles;
  return {
    ensureFiles: () => on(() => undefined, openStore),
    ...groups,
    rejections: sqliteRefusedAmong(on),
    importKeys: sqliteImportKeys(on),
  };
}

/** The built-in store: hippo.db under the port's own method names, each call on its own short-lived handles. */
export function sqliteSyncStore(
  hippoRoot: string,
  rules: LossAversion = {},
): SqliteSyncStore & Sync<Omit<StoreGroups, AsyncOnly>> {
  const handles = handlesOf(hippoRoot, rules);
  const { on } = handles;
  const localGroups = sqliteLocalGroups(handles);
  const localFiles = sqliteLocalFiles(handles, localGroups);
  return {
    kind: 'sqlite',
    localFiles,
    ...localGroups,
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
    lastRecall: sqliteLastRecall(handles),
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
    ...sqliteFolderGroups(handles),
    close() {
      flushHeldMirrors(hippoRoot);
    },
  };
}

type FolderGroups = Pick<StoreGroups, 'ledger' | 'embeddingIndex' | 'promotion' | 'folderFiles' | 'sharing'>;

/** The groups only a store kept as files in a folder serves: its ledger, own index, promote copies and sharing. */
function sqliteFolderGroups(handles: Handles): Sync<FolderGroups> {
  return {
    ledger: sqliteLedger(handles.on),
    embeddingIndex: sqliteEmbeddingIndex(handles),
    promotion: sqlitePromotion(handles),
    folderFiles: sqliteFolderFiles(handles),
    sharing: sqliteSharing(handles.on),
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

const baseReadsAt: Bodies<Pick<HippoStore, 'findApiKey' | 'activeGoals' | 'planningFallacyEvidence'>> = {
  findApiKey: readApiKeyRecord,
  activeGoals: activeGoalsWithPoliciesAt,
  planningFallacyEvidence: planningFallacyEvidenceAt,
};

const entryReadsAt: Bodies<Pick<HippoStore, 'searchRecallEntries' | 'entriesByIds' | 'freshRawEntries'>> = {
  searchRecallEntries: loadRecallEntriesAt,
  entriesByIds: loadEntriesByIdsAt,
  freshRawEntries: loadFreshRawMemoriesAt,
};

function sqliteBaseReads(on: OnHandle): SqliteBaseReads {
  return {
    ...bound(on, baseReadsAt),
    ...bound(on, entryReadsAt, openStore),
    ...boundWithFiles<Pick<HippoStore, 'continuity'>>(on, { continuity: continuityAt }, openStore),
  };
}

type SqliteRecallWrites = Pick<
  SqliteSyncStore,
  'appendAuditEvents' | 'finishRecall' | 'bumpRecallStats' | 'recordTokens'
>;

const recallWritesAt: Bodies<Pick<HippoStore, 'appendAuditEvents' | 'recordTokens'>> = {
  appendAuditEvents: appendAuditEventsAt,
  recordTokens: recordTokenUse,
};

// It strengthens, so it takes the store's loss-aversion rules beside the handle.
const recallFinishAt: FileBodies<Pick<HippoStore, 'finishRecall'>> = {
  finishRecall: (db, files, recall) => {
    finishRecallAt(db, files, recall);
  },
};

function sqliteRecallWrites(on: OnHandle): SqliteRecallWrites {
  const writes = bound(on, recallWritesAt);
  return {
    ...writes,
    appendAuditEvents: skipEmpty(writes.appendAuditEvents, () => undefined),
    ...boundWithFiles(on, recallFinishAt),
    ...boundWithFiles<Pick<HippoStore, 'bumpRecallStats'>>(
      on,
      { bumpRecallStats: (db, files, recalled) => updateStatsAt(db, files, { recalled }) },
      openStore,
    ),
  };
}

function sqliteVectorViews(on: OnHandle): Sync<VectorViews> {
  return bound<VectorViews>(on, { storedVectorViews: loadStoredVectorViewsAt });
}

function sqliteVectorWrites(on: OnHandle): Sync<VectorWrites> {
  return bound<VectorWrites>(on, { entriesWithoutVector: entriesWithoutVectorAt, writeVectors: writeVectorsAt });
}

function sqliteAuditLog(on: OnHandle): Sync<AuditLog> {
  return bound<AuditLog>(on, { listAuditEvents: queryAuditEvents });
}

function sqliteReadiness(hippoRoot: string, on: OnHandle): Sync<Readiness> {
  return {
    ping() {
      // A probe must not create the store; the first write does, so a root with none yet is ready.
      if (!existsSync(getHippoDbPath(hippoRoot))) return;
      on((db) => {
        db.prepare('SELECT 1').get();
      });
    },
  };
}

/** What a call on `store` reaches, probed as the api's own context plan did (`shared` is the transport's flag);
 * `openGlobal` builds the global store, read and written, which a server keeps on threads of its own. */
export function sqliteReach(
  hippoRoot: string,
  store: HippoStore,
  shared?: boolean,
  openGlobal: (root: string) => LocalStore & StoreGroups = sqliteStore,
): StoreReach {
  const other = isLocalStore(store) ? undefined : store;
  const sharedStore = shared === true || isSharedStore(hippoRoot);
  const globalRoot = resolveGlobalRootDir();
  const canReadGlobal = !sharedStore && other === undefined && isInitialized(globalRoot);
  const globalTarget = other === undefined ? { root: globalRoot, store: openGlobal(globalRoot) } : undefined;
  const reach: StoreReach = {
    hasLocal: other !== undefined || isInitialized(hippoRoot),
    isGlobal: isGlobalStoreRoot(hippoRoot),
    shared: sharedStore,
    isHippoDb: other === undefined,
    globalTarget,
  };
  if (!canReadGlobal) return reach;
  return { ...reach, global: { root: globalRoot, store: openGlobal(globalRoot) } };
}

/** `sqliteSyncStore` as a served store: each method runs at once and answers through a Promise, so a throw rejects as
 * another store's would. */
export function sqliteStore(hippoRoot: string, rules: LossAversion = {}): LocalStore & StoreGroups {
  const handles = handlesOf(hippoRoot, rules);
  const sync = sqliteSyncStore(hippoRoot, rules);
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
    ledger: served<Ledger>(sync.ledger),
    embeddingIndex: served<EmbeddingIndex>(sync.embeddingIndex),
    promotion: served<Promotion>(sync.promotion),
    folderFiles: served<FolderFiles>(sync.folderFiles),
    sharing: served<Sharing>(sync.sharing),
    consolidation: served<Consolidation>(sync.consolidation),
    learning: served<Learning>(sync.learning),
    captures: served<Captures>(sync.captures),
    compactionHooks: served<CompactionHooks>(sync.compactionHooks),
    projectTags: served<ProjectTags>(sync.projectTags),
    diagnostics: served<Diagnostics>(sync.diagnostics),
    graphRebuild: served<GraphRebuild>(sync.graphRebuild),
    agentImport: served<AgentImport>(sync.agentImport),
    close: async () => sync.close(),
  };
}

type ServedBaseMethods = Pick<
  HippoStore,
  | 'kind'
  | 'findApiKey'
  | 'searchRecallEntries'
  | 'entriesByIds'
  | 'activeGoals'
  | 'freshRawEntries'
  | 'continuity'
  | 'planningFallacyEvidence'
  | 'appendAuditEvents'
  | 'finishRecall'
  | 'bumpRecallStats'
  | 'recordTokens'
>;

function baseMethodsOf(sync: SqliteSyncStore): Sync<ServedBaseMethods> {
  const {
    kind,
    findApiKey,
    searchRecallEntries,
    entriesByIds,
    activeGoals,
    freshRawEntries,
    continuity,
    planningFallacyEvidence,
    appendAuditEvents,
    finishRecall,
    bumpRecallStats,
    recordTokens,
  } = sync;
  return {
    kind,
    findApiKey,
    searchRecallEntries,
    entriesByIds,
    activeGoals,
    freshRawEntries,
    continuity,
    planningFallacyEvidence,
    appendAuditEvents,
    finishRecall,
    bumpRecallStats,
    recordTokens,
  };
}

const contextReadsAt: Bodies<Omit<ContextReads, 'ambientTallies'>> = {
  unfinishedHandoff: (db, tenantId, maxAgeMs, key) =>
    loadLatestHandoffAt(db, tenantId, undefined, { unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' }, key),
  ambientCandidates: (db, tenantId, { admit, ...request }) =>
    loadAmbientCandidatesAt(db, tenantId, { ...request, judge: (e) => ambientRefusal(e, admit) }),
  contextCandidates: loadContextCandidatesAt,
  newestEntries: newestEntriesAt,
  schemaFit: schemaFitAt,
  liveContentsBySourceAndTag: liveContentsBySourceAndTagAt,
  rawRowsUnderRef: rawRowsUnderRefAt,
};

function sqliteContextReads(on: OnHandle): Sync<ContextReads> {
  return {
    ...bound(on, contextReadsAt, openStore),
    ...boundWithFiles<Pick<ContextReads, 'ambientTallies'>>(on, { ambientTallies: loadAmbientTalliesAt }, openStore),
  };
}

/** sqliteStore's continuity read, for the synchronous recall that cannot await the port. */
function continuityAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  eventLimit: number,
  key: ContinuityKey | null,
): ContinuityBlock {
  const activeSnapshot = loadActiveTaskSnapshotAt(db, files, tenantId, key);
  const sessionId = activeSnapshot?.session_id ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? loadLatestHandoffAt(db, tenantId, sessionId, {}, key) : null,
    recentSessionEvents: sessionId
      ? listSessionEventsAt(db, tenantId, { session_id: sessionId, limit: eventLimit })
      : [],
  };
}
