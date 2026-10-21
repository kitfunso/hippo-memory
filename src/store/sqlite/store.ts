// The built-in SQLite adapter behind the store port.
import { loadAmbientTallies } from './ambient.js';
import type { LossAversion } from '../../base/memory/memory.js';
import { ambientRefusal } from '../../base/scope/read-admission.js';
import { readApiKeyRecord } from './auth.js';
import { existsSync } from 'node:fs';
import { appendAuditEvents, queryAuditEvents } from './audit.js';
import { getHippoDbPath, openHippoDbReadOnly, type DatabaseSyncLike } from '../../db/index.js';
import { activeGoalsWithPolicies, sqliteGoals } from './goals.js';
import { planningFallacyEvidence } from './planning-fallacy-evidence.js';
import { sqlitePredictions } from './predictions.js';
import { recordTokenUse } from './token-ledger.js';
import { loadAmbientCandidates, loadContextCandidates, newestEntries, schemaFit } from './candidates.js';
import { liveContentsBySourceAndTag, loadEntriesByIds, loadFreshRawMemories, rawRowsUnderRef } from './entry-reads.js';
import { sqliteAgentImport } from './agent-import.js';
import { sqliteCaptures } from './captures.js';
import { sqliteCompactionHooks } from './compaction-hooks.js';
import { sqliteCards } from './cards.js';
import { sqliteConflicts } from './conflicts.js';
import { sqliteDormant } from './dormant.js';
import { sqliteRejections } from './rejections.js';
import { sqliteFailureLog } from './failure-log.js';
import { sqliteCompactions } from './compactions.js';
import { sqliteReports } from './reports.js';
import { sqliteSessions, listSessionEvents } from './sessions.js';
import { sqliteConnectorEvents } from './connector-events.js';
import { sqliteConnectorWrites } from './connector-writes.js';
import { servedConsolidation, sqliteConsolidation, type SqliteConsolidation } from './consolidation.js';
import { sqliteLearning } from './learning.js';
import { sqlitePromotion } from './promotion.js';
import { sqliteProjectTags } from './project-tags.js';
import { sqliteSharing } from './sharing.js';
import { sqliteDiagnostics } from './diagnostics.js';
import { sqliteEmbeddingIndex } from './embedding-index.js';
import { sqliteGraphRebuild } from './graph-rebuild.js';
import { sqliteLedger } from './ledger.js';
import { sqliteFolderFiles } from './folder-files.js';
import { sqliteDagReads } from './dag-reads.js';
import { sqliteEntryWrites } from './entry-writes.js';
import { sqliteAuditMaintenance } from './audit-maintenance.js';
import { sqliteLessonWrites } from './lesson-writes.js';
import { finishRecall, sqliteLastRecall } from './last-recall.js';
import { sqliteGraphReads } from './graph-reads.js';
import { sqliteObjects } from './objects.js';
import { sqliteQuarantine } from './quarantine.js';
import { sqliteVectorReads } from './vector-reads.js';
import { loadLatestHandoff } from './handoffs.js';
import { updateStats } from './index-and-stats.js';
import { flushHeldMirrors } from './mirrors.js';
import { sqliteKeyAudit, sqliteKeyGrants, sqliteKeyWrites } from './keys.js';
import type { Handles, OnHandle, StoreFiles } from './open.js';
import { handlesOf, openStore } from './handles.js';
import { bound, boundWithFiles, skipEmpty, type Bodies, type FileBodies } from './bound.js';
import type {
  AuditLog,
  BaseMethods,
  CaptureGroups,
  ContextReads,
  ContinuityBlock,
  FolderGroups,
  HippoStore,
  MaintenanceGroups,
  Readiness,
  SleepGroups,
  StoreGroups,
  StoreReach,
  VectorViews,
  VectorWrites,
} from '../port.js';
import type { Sync } from './served.js';
import type { ProjectTags } from '../port/project-tags.js';
import type { Diagnostics } from '../port/diagnostics.js';
import { served } from './served.js';
import { asHippoDb, isHippoDbStore } from './hippo-db-stores.js';
import { isSharedStore } from '../../base/config/config.js';
import { isGlobalStoreRoot, isInitialized, resolveGlobalRootDir } from '../../base/scope/project-identity.js';
import { loadRecallEntries } from './search-rows.js';
import { loadActiveTaskSnapshot } from './task-snapshots.js';
import { entriesWithoutVector, loadStoredVectorViews, writeVectors } from './vector-index.js';
import type { ContinuityKey } from '../port/types.js';

/** Served apart from the generic wrap: the nearest-row scan yields to the event loop, so `vectors` has no synchronous
 * form, and consolidation keeps its chunked flush async. */
type ServedApart = 'vectors' | 'consolidation';

/** The port as hippo.db answers it: each call runs to its end and returns the value, so no write scope spans an await.
 */
export type SqliteSyncStore = Sync<Omit<HippoStore & StoreGroups, ServedApart>> & {
  readonly consolidation: SqliteConsolidation;
};

/** hippo.db's own files beside its rows; consolidation keeps its chunked flush async, so it is served apart. */
type LocalGroups = Sync<Omit<SleepGroups, 'consolidation'> & CaptureGroups & MaintenanceGroups> & {
  readonly consolidation: SqliteConsolidation;
};

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
    agentImport: sqliteAgentImport(on),
  };
}

/** The built-in store: hippo.db under the port's own method names, each call on its own short-lived handles. The
 * caller passes the handles, so a store built over this one opens a single set. */
export function sqliteSyncStore(handles: Handles): SqliteSyncStore {
  const { on, files } = handles;
  return {
    kind: 'sqlite',
    ...sqliteLocalGroups(handles),
    ...sqliteBaseMethods(on),
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
    readiness: sqliteReadiness(files.hippoRoot, on),
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
      flushHeldMirrors(files.hippoRoot);
    },
  };
}

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

const baseReadsBodies: Bodies<Pick<BaseMethods, 'findApiKey' | 'activeGoals' | 'planningFallacyEvidence'>> = {
  findApiKey: readApiKeyRecord,
  activeGoals: activeGoalsWithPolicies,
  planningFallacyEvidence: planningFallacyEvidence,
};

const entryReadsBodies: Bodies<Pick<BaseMethods, 'searchRecallEntries' | 'entriesByIds' | 'freshRawEntries'>> = {
  searchRecallEntries: loadRecallEntries,
  entriesByIds: loadEntriesByIds,
  freshRawEntries: loadFreshRawMemories,
};

const storeFilesBodies: FileBodies<Pick<BaseMethods, 'continuity' | 'bumpRecallStats'>> = {
  continuity: continuity,
  bumpRecallStats: (db, files, recalled) => updateStats(db, files, { recalled }),
};

const recallWritesBodies: Bodies<Pick<BaseMethods, 'appendAuditEvents' | 'recordTokens'>> = {
  appendAuditEvents: appendAuditEvents,
  recordTokens: recordTokenUse,
};

// It strengthens, so it takes the store's loss-aversion rules beside the handle.
const recallFinishBodies: FileBodies<Pick<BaseMethods, 'finishRecall'>> = {
  finishRecall: (db, files, recall) => {
    finishRecall(db, files, recall);
  },
};

function sqliteBaseMethods(on: OnHandle): Sync<BaseMethods> {
  const writes = bound(on, recallWritesBodies);
  return {
    ...bound(on, baseReadsBodies),
    ...bound(on, entryReadsBodies, openStore),
    ...boundWithFiles(on, storeFilesBodies, openStore),
    ...writes,
    appendAuditEvents: skipEmpty(writes.appendAuditEvents, () => undefined),
    ...boundWithFiles(on, recallFinishBodies),
  };
}

function sqliteVectorViews(on: OnHandle): Sync<VectorViews> {
  return bound<VectorViews>(on, { storedVectorViews: loadStoredVectorViews });
}

function sqliteVectorWrites(on: OnHandle): Sync<VectorWrites> {
  return bound<VectorWrites>(on, { entriesWithoutVector: entriesWithoutVector, writeVectors: writeVectors });
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
  openGlobal: (root: string) => HippoStore & StoreGroups = sqliteStore,
): StoreReach {
  const other = isHippoDbStore(store) ? undefined : store;
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

/** hippo.db as `hippo doctor` and `hippo support-bundle` read it: diagnostics and the project-tag reads on read-only
 * handles, so a check never creates or migrates the store it inspects. */
export function sqliteDiagnosticsStore(hippoRoot: string): Pick<StoreGroups, 'diagnostics' | 'projectTags'> {
  const { on } = handlesOf(hippoRoot);
  return {
    diagnostics: served<Diagnostics>(sqliteDiagnostics(on)),
    projectTags: served<ProjectTags>(sqliteProjectTags(on, openHippoDbReadOnly)),
  };
}

/** `sqliteSyncStore` as a served store: each method runs at once and answers through a Promise, so a throw rejects as
 * another store's would. */
export function sqliteStore(hippoRoot: string, rules: LossAversion = {}): HippoStore & StoreGroups {
  const handles = handlesOf(hippoRoot, rules);
  const { consolidation, ...sync } = sqliteSyncStore(handles);
  return asHippoDb({
    ...served<Omit<HippoStore & StoreGroups, ServedApart>>(sync),
    vectors: sqliteVectorReads(handles),
    consolidation: servedConsolidation(consolidation),
  });
}

const contextReadsBodies: Bodies<Omit<ContextReads, 'ambientTallies'>> = {
  unfinishedHandoff: (db, tenantId, maxAgeMs, key) =>
    loadLatestHandoff(db, tenantId, undefined, { unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' }, key),
  ambientCandidates: (db, tenantId, { admit, ...request }) =>
    loadAmbientCandidates(db, tenantId, { ...request, judge: (e) => ambientRefusal(e, admit) }),
  contextCandidates: loadContextCandidates,
  newestEntries: newestEntries,
  schemaFit: schemaFit,
  liveContentsBySourceAndTag: liveContentsBySourceAndTag,
  rawRowsUnderRef: rawRowsUnderRef,
};

function sqliteContextReads(on: OnHandle): Sync<ContextReads> {
  return {
    ...bound(on, contextReadsBodies, openStore),
    ...boundWithFiles<Pick<ContextReads, 'ambientTallies'>>(on, { ambientTallies: loadAmbientTallies }, openStore),
  };
}

/** sqliteStore's continuity read, for the synchronous recall that cannot await the port. */
function continuity(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  eventLimit: number,
  key: ContinuityKey | null,
): ContinuityBlock {
  const activeSnapshot = loadActiveTaskSnapshot(db, files, tenantId, key);
  const sessionId = activeSnapshot?.sessionId ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? loadLatestHandoff(db, tenantId, sessionId, {}, key) : null,
    recentSessionEvents: sessionId ? listSessionEvents(db, tenantId, { session_id: sessionId, limit: eventLimit }) : [],
  };
}
