// The built-in SQLite adapter behind the store port.
import { countAmbient } from './recall/ambient.js';
import type { StoreRules } from '../../base/ports/infra.js';
import { ambientRefusal } from '../../base/scope/read-admission.js';
import { readApiKeyRecord } from './keys/auth.js';
import { existsSync } from 'node:fs';
import { appendAuditEvents, listAuditEvents } from './audit/audit.js';
import { getHippoDbPath, openHippoDbReadOnly, type DatabaseSyncLike } from '../../db/index.js';
import { activeGoalsWithPolicies, sqliteGoals } from './sessions/goals.js';
import { planningFallacyEvidence } from './learning/planning-fallacy-evidence.js';
import { recordTokenUse } from './ledger/token-ledger.js';
import { listAmbientCandidates, listContextCandidates, schemaFit } from './recall/candidates.js';
import { readEntriesInIdOrder, listFreshRawMemories } from './entries/entry-reads.js';
import { listEntriesWhere } from './entries/entry-filter.js';
import { sqliteAgentImport } from './maintenance/agent-import.js';
import { sqliteCaptures } from './capture/captures.js';
import { sqliteCompactionHooks } from './capture/compaction-hooks.js';
import { sqliteCards } from './records/cards.js';
import { sqliteConflicts } from './review/conflicts.js';
import { sqliteDormant } from './dormant/dormant.js';
import { sqliteRejections } from './review/rejections.js';
import { sqliteFailureLog } from './capture/failure-log.js';
import { sqliteCompactions } from './capture/compactions.js';
import { sqliteReports } from './reports/reports.js';
import { sqliteSessions, listSessionEvents } from './sessions/sessions.js';
import { sqliteConnectorEvents } from './connectors/connector-events.js';
import { sqliteConnectorWrites } from './connectors/connector-writes.js';
import { sqliteConsolidation } from './consolidation/consolidation.js';
import { sqliteLearning } from './learning/learning.js';
import { sqlitePromotion } from './sharing/promotion.js';
import { sqliteProjectTags } from './maintenance/project-tags.js';
import { sqliteSharing } from './sharing/sharing.js';
import { sqliteDiagnostics } from './maintenance/diagnostics.js';
import { sqliteEmbeddingIndex } from './vectors/embedding-index.js';
import { sqliteGraphRebuild } from './graph/graph-rebuild.js';
import { sqliteLedger } from './ledger/ledger.js';
import { sqliteFolderFiles } from './folder-files/folder-files.js';
import { sqliteDagReads } from './graph/dag-reads.js';
import { sqliteEntryWrites } from './entries/entry-writes.js';
import { sqliteAuditMaintenance } from './audit/audit-maintenance.js';
import { sqliteLessonWrites } from './learning/lesson-writes.js';
import { finishRecall, sqliteLastRecall } from './recall/last-recall.js';
import { sqliteGraphReads } from './graph/graph-reads.js';
import { sqliteObjects } from './records/objects.js';
import { sqliteQuarantine } from './connectors/quarantine.js';
import { sqliteVectorReads } from './vectors/vector-reads.js';
import { readLatestHandoff } from './sessions/handoffs.js';
import { updateStats } from './entries/index-and-stats.js';
import { flushHeldMirrors } from './folder-files/mirrors.js';
import { sqliteKeyWrites } from './keys/keys.js';
import type { Handles, OnHandle, StoreFiles } from './runtime/open.js';
import { handlesOf, openStore } from './runtime/handles.js';
import { answered, bound, skipEmpty, type Bodies } from './runtime/bound.js';
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
  VectorWrites,
} from '../../base/ports/store.js';
import { asHippoDb, isHippoDbStore } from './runtime/hippo-db-stores.js';
import { createHost, type Host } from '../../host/host.js';
import { isGlobalStoreRoot, isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { listRecallEntries } from './recall/search-rows.js';
import { readActiveTaskSnapshot } from './sessions/task-snapshots.js';
import { entriesWithoutVector, writeVectors } from './vectors/vector-index.js';
import type { ContinuityKey } from '../../base/ports/store/types.js';
import type { ProjectTagReads } from '../../base/ports/store/project-tags.js';

/** The groups that read and write hippo.db's own files beside its rows. */
function sqliteLocalGroups(handles: Handles): SleepGroups & CaptureGroups & MaintenanceGroups {
  const { on } = handles;
  return {
    consolidation: sqliteConsolidation(handles),
    learning: sqliteLearning(handles),
    captures: sqliteCaptures(handles),
    compactionHooks: sqliteCompactionHooks(handles),
    projectTags: sqliteProjectTags(handles),
    diagnostics: sqliteDiagnostics(on),
    graphRebuild: sqliteGraphRebuild(on),
    agentImport: sqliteAgentImport(handles),
  };
}

/** The built-in store on `handles`: hippo.db under the port's own method names, each call run to its end on its own
 * short-lived handle before its Promise settles, so no write scope spans an await. The caller passes the handles, so a
 * store built over this one opens a single set, and a store worker's opens all reach its thread's one connection. */
export function sqliteStoreOn(handles: Handles): HippoStore & StoreGroups {
  const { on, files } = handles;
  return {
    kind: 'sqlite',
    ...sqliteLocalGroups(handles),
    ...sqliteBaseMethods(handles),
    keyWrites: sqliteKeyWrites(on),
    vectorWrites: sqliteVectorWrites(on),
    entryWrites: sqliteEntryWrites(handles),
    contextReads: sqliteContextReads(handles),
    dagReads: sqliteDagReads(on),
    auditLog: sqliteAuditLog(on),
    quarantine: sqliteQuarantine(handles),
    graphReads: sqliteGraphReads(on),
    connectorWrites: sqliteConnectorWrites(handles),
    connectorEvents: sqliteConnectorEvents(on),
    objects: sqliteObjects(handles),
    readiness: sqliteReadiness(files.hippoRoot, on),
    vectors: sqliteVectorReads(handles),
    lastRecall: sqliteLastRecall(handles),
    auditMaintenance: sqliteAuditMaintenance(handles),
    lessonWrites: sqliteLessonWrites(handles),
    sessions: sqliteSessions(handles),
    cards: sqliteCards(on),
    goals: sqliteGoals(on),
    conflicts: sqliteConflicts(handles),
    dormant: sqliteDormant(handles),
    reports: sqliteReports(handles),
    rejections: sqliteRejections(handles),
    failureLog: sqliteFailureLog(on),
    compactions: sqliteCompactions(handles),
    ...sqliteFolderGroups(handles),
    close: () => answered(() => flushHeldMirrors(files.hippoRoot)),
  };
}

/** The groups only a store kept as files in a folder serves: its ledger, own index, promote copies and sharing. */
function sqliteFolderGroups(handles: Handles): FolderGroups {
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
  searchRecallEntries: listRecallEntries,
  entriesByIds: readEntriesInIdOrder,
  freshRawEntries: listFreshRawMemories,
};

function storeFilesBodies(files: StoreFiles): Bodies<Pick<BaseMethods, 'continuity' | 'bumpRecallStats'>> {
  return {
    continuity: (db, ...args) => continuity(db, files, ...args),
    bumpRecallStats: (db, recalled) => updateStats(db, files, { recalled }),
  };
}

const recallWritesBodies: Bodies<Pick<BaseMethods, 'appendAuditEvents' | 'recordTokens'>> = {
  appendAuditEvents: appendAuditEvents,
  recordTokens: recordTokenUse,
};

function sqliteBaseMethods({ on, files }: Handles): BaseMethods {
  const writes = bound(on, recallWritesBodies);
  return {
    ...bound(on, baseReadsBodies),
    ...bound(on, entryReadsBodies, openStore),
    ...bound(on, storeFilesBodies(files), openStore),
    ...writes,
    appendAuditEvents: skipEmpty(writes.appendAuditEvents, () => undefined),
    // It strengthens, so it scores by the store's strength model.
    ...bound<Pick<BaseMethods, 'finishRecall'>>(on, {
      finishRecall: (db, recall) => {
        finishRecall(db, files, recall);
      },
    }),
  };
}

function sqliteVectorWrites(on: OnHandle): VectorWrites {
  return bound<VectorWrites>(on, { entriesWithoutVector: entriesWithoutVector, writeVectors: writeVectors });
}

function sqliteAuditLog(on: OnHandle): AuditLog {
  return bound<AuditLog>(on, { listAuditEvents });
}

function sqliteReadiness(hippoRoot: string, on: OnHandle): Readiness {
  return {
    ping: () =>
      answered(() => {
        // A probe must not create the store; the first write does, so a root with none yet is ready.
        if (!existsSync(getHippoDbPath(hippoRoot))) return;
        on((db) => {
          db.prepare('SELECT 1').get();
        });
      }),
  };
}

/** What a call on `store` reaches, probed as the api's own context plan did (`shared` is the transport's flag);
 * `openGlobal` builds the global store, read and written, which a server keeps on threads of its own. A root that
 * probes per request passes its own `host`, so a store once shared stays shared for it. */
export function sqliteReach(
  hippoRoot: string,
  store: HippoStore,
  shared?: boolean,
  openGlobal: (root: string) => HippoStore & StoreGroups = sqliteStore,
  host: Host = createHost(),
): StoreReach {
  const other = isHippoDbStore(store) ? undefined : store;
  const sharedStore = shared === true || host.isSharedStore(hippoRoot);
  const globalRoot = hippoHomeDir();
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
export function sqliteDiagnosticsStore(hippoRoot: string): Pick<StoreGroups, 'diagnostics'> & ProjectTagReads {
  const handles = handlesOf(hippoRoot);
  const { on } = handles;
  return {
    diagnostics: sqliteDiagnostics(on),
    projectTags: sqliteProjectTags(handles, openHippoDbReadOnly),
    reports: bound<ProjectTagReads['reports']>(on, { entriesWhere: listEntriesWhere }, openHippoDbReadOnly),
    auditLog: bound<ProjectTagReads['auditLog']>(on, { listAuditEvents }, openHippoDbReadOnly),
  };
}

/** The built-in store on hippo.db under `hippoRoot`, scored by `rules`. */
export function sqliteStore(hippoRoot: string, rules: StoreRules = {}): HippoStore & StoreGroups {
  return asHippoDb(sqliteStoreOn(handlesOf(hippoRoot, rules)));
}

const contextReadsBodies: Bodies<Omit<ContextReads, 'ambientTallies' | 'contextCandidates'>> = {
  ambientCandidates: (db, tenantId, { admit, ...request }) =>
    listAmbientCandidates(db, tenantId, { ...request, judge: (e) => ambientRefusal(e, admit) }),
  schemaFit: schemaFit,
};

function sqliteContextReads({ on, files }: Handles): ContextReads {
  return {
    ...bound(on, contextReadsBodies, openStore),
    ...bound<Pick<ContextReads, 'ambientTallies' | 'contextCandidates'>>(
      on,
      {
        ambientTallies: (db, ...args) => countAmbient(db, files, ...args),
        contextCandidates: (db, ...args) => listContextCandidates(db, files.strength, ...args),
      },
      openStore,
    ),
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
  const activeSnapshot = readActiveTaskSnapshot(db, files, tenantId, key);
  const sessionId = activeSnapshot?.sessionId ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? readLatestHandoff(db, tenantId, sessionId, {}, key) : null,
    recentSessionEvents: sessionId ? listSessionEvents(db, tenantId, { session_id: sessionId, limit: eventLimit }) : [],
  };
}
