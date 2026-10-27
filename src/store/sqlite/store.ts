// The built-in SQLite adapter behind the store port.
import { countAmbient } from './ambient.js';
import type { SqliteStoreOptions } from './grant.js';
import { ambientRefusal } from '../../base/scope/read-admission.js';
import { readApiKeyRecord } from './auth.js';
import { existsSync } from 'node:fs';
import { appendAuditEvents, listAuditEvents } from './audit.js';
import {
  getHippoDbPath,
  openHippoDbReadOnly,
  type DatabaseSyncLike,
  type RequestStores,
} from '../../db/index.js';
import { activeGoalsWithPolicies, sqliteGoals } from './goals.js';
import { planningFallacyEvidence } from './planning-fallacy-evidence.js';
import { recordTokenUse } from './token-ledger.js';
import { listAmbientCandidates, listContextCandidates } from './candidates.js';
import { schemaFit } from './schema-fit.js';
import { readEntriesInIdOrder, listFreshRawMemories } from './entry-reads.js';
import { listEntriesWhere } from './entry-filter.js';
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
import { sqliteConsolidation } from './consolidation.js';
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
import { sqliteEntryWrites } from './entry-lifecycle.js';
import { sqliteAuditMaintenance } from './audit-maintenance.js';
import { sqliteLessonWrites } from './lesson-writes.js';
import { finishRecall, sqliteLastRecall } from './last-recall.js';
import { sqliteGraphReads } from './graph-reads.js';
import { sqliteObjects } from './objects.js';
import { sqliteQuarantine } from './quarantine.js';
import { sqliteVectorReads } from './vector-reads.js';
import { readLatestHandoff } from './handoffs.js';
import { updateStats } from './index-and-stats.js';

import { sqliteKeyWrites } from './keys.js';
import type { Handles, OnHandle, StoreFiles } from './open.js';
import { handlesOf, openStore } from './handles.js';
import { answered, bound, skipEmpty, type Bodies } from './bound.js';
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
import { asHippoDb, isHippoDbStore } from './hippo-db-stores.js';
import { createHost, type Host } from '../../host/host.js';
import { isGlobalStoreRoot, isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { listRecallEntries } from './search-rows.js';
import { readActiveTaskSnapshot } from './task-snapshots.js';
import { entriesWithoutVector, writeVectors } from './vector-index.js';
import type { ContinuityKey } from '../../base/ports/store/types.js';
import type { ProjectTagReads } from '../../base/ports/store/project-tags.js';
import { asViewOf } from '../../base/util/store-view.js';

/** The groups that read and write hippo.db's own files beside its rows, and the rest of sleep's
 * and capture's. */
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
    lessonWrites: sqliteLessonWrites(handles),
    auditMaintenance: sqliteAuditMaintenance(handles),
    dormant: sqliteDormant(handles),
    compactions: sqliteCompactions(handles),
    failureLog: sqliteFailureLog(on),
  };
}

/** The built-in store on `handles`: hippo.db under the port's own method names, each call run to
 * its end on its own short-lived handle before its Promise settles, so no write scope spans an
 * await. The caller passes the handles, so a store built over this one opens a single set, and a
 * store worker's opens all reach its thread's one connection. */
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
    sessions: sqliteSessions(handles),
    cards: sqliteCards(on),
    goals: sqliteGoals(on),
    conflicts: sqliteConflicts(handles),
    reports: sqliteReports(handles),
    rejections: sqliteRejections(handles),
    ...sqliteFolderGroups(handles),
    close: () => answered(() => files.runtime?.held.flush(files.hippoRoot)),
  };
}

/** The groups only a store kept as files in a folder serves: its ledger, own index, promote
 * copies and sharing. */
function sqliteFolderGroups(handles: Handles): FolderGroups {
  return {
    ledger: sqliteLedger(handles.on, handles.files.opens.grant?.session),
    embeddingIndex: sqliteEmbeddingIndex(handles),
    promotion: sqlitePromotion(handles),
    folderFiles: sqliteFolderFiles(handles),
    sharing: sqliteSharing(handles.on),
  };
}

const baseReadsBodies: Bodies<
  Pick<BaseMethods, 'findApiKey' | 'activeGoals' | 'planningFallacyEvidence'>
> = {
  findApiKey: readApiKeyRecord,
  activeGoals: activeGoalsWithPolicies,
  planningFallacyEvidence: planningFallacyEvidence,
};

const entryReadsBodies: Bodies<
  Pick<BaseMethods, 'searchRecallEntries' | 'entriesByIds' | 'freshRawEntries'>
> = {
  searchRecallEntries: listRecallEntries,
  entriesByIds: readEntriesInIdOrder,
  freshRawEntries: listFreshRawMemories,
};

function storeFilesBodies(
  files: StoreFiles,
): Bodies<Pick<BaseMethods, 'continuity' | 'bumpRecallStats' | 'bumpRemembered'>> {
  return {
    continuity: (db, ...args) => continuity(db, files, ...args),
    bumpRecallStats: (db, recalled) => updateStats(db, files, { recalled }),
    bumpRemembered: (db, count) => updateStats(db, files, { remembered: count }),
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
  return bound<VectorWrites>(on, {
    entriesWithoutVector: entriesWithoutVector,
    writeVectors: writeVectors,
  });
}

function sqliteAuditLog(on: OnHandle): AuditLog {
  return bound<AuditLog>(on, { listAuditEvents });
}

function sqliteReadiness(hippoRoot: string, on: OnHandle): Readiness {
  return {
    ping: () =>
      answered(() => {
        // A probe must not create the store; the first write does, so a root with none yet is
        // ready.
        if (!existsSync(getHippoDbPath(hippoRoot))) return;
        on((db) => {
          db.prepare('SELECT 1').get();
        });
      }),
  };
}

export interface SqliteReachOptions {
  readonly hippoRoot: string;
  readonly store: HippoStore;
  readonly shared?: boolean;
  readonly openGlobal?: (root: string) => HippoStore & StoreGroups;
  readonly host?: Host;
}

/** What a call on `store` reaches, probed as the api's own context plan did (`shared` is the
 * transport's flag); `openGlobal` builds the global store, read and written, which a server
 * keeps on threads of its own. A root that probes per request passes its own `host`, so a store
 * once shared stays shared for it. */
export function sqliteReach({
  hippoRoot,
  store,
  shared,
  openGlobal = sqliteStore,
  host = createHost(),
}: SqliteReachOptions): StoreReach {
  const other = isHippoDbStore(store) ? undefined : store;
  const sharedStore = shared === true || host.isSharedStore(hippoRoot);
  const globalRoot = hippoHomeDir();
  const canReadGlobal = !sharedStore && other === undefined && isInitialized(globalRoot);
  const globalTarget =
    other === undefined ? { root: globalRoot, store: openGlobal(globalRoot) } : undefined;
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

/** hippo.db as `hippo doctor` and `hippo support-bundle` read it: diagnostics and the
 * project-tag reads on read-only handles, so a check never creates or migrates the store it
 * inspects. */
export function sqliteDiagnosticsStore(
  hippoRoot: string,
): Pick<StoreGroups, 'diagnostics'> & ProjectTagReads {
  const handles = handlesOf(hippoRoot);
  const { on } = handles;
  return {
    diagnostics: sqliteDiagnostics(on),
    projectTags: sqliteProjectTags(handles, openHippoDbReadOnly),
    reports: bound<ProjectTagReads['reports']>(
      on,
      { entriesWhere: listEntriesWhere },
      openHippoDbReadOnly,
    ),
    auditLog: bound<ProjectTagReads['auditLog']>(on, { listAuditEvents }, openHippoDbReadOnly),
  };
}

// Each store sqliteStore built, with how to build it again on one session's handles.
const reopeners = new WeakMap<HippoStore, (session: RequestStores) => HippoStore & StoreGroups>();

/** The built-in store on hippo.db under `hippoRoot`, scored by `opts`' rules and opened with its
 * runtime and session. */
export function sqliteStore(
  hippoRoot: string,
  opts: SqliteStoreOptions = {},
): HippoStore & StoreGroups {
  const store = asHippoDb(sqliteStoreOn(handlesOf(hippoRoot, opts)));
  reopeners.set(store, (session) => sqliteStore(hippoRoot, { ...opts, session }));
  return store;
}

/** `store` on `session`'s handles when sqliteStore built it, so a pass of many calls opens
 * hippo.db once; any other store, a caller's copy of one included, as it is. */
export function inSqliteSession<S extends HippoStore>(store: S, session: RequestStores): S {
  const reopen = reopeners.get(store);
  // SAFETY: only sqliteStore's own result is a key, and the reopener builds that same store on
  // another session.
  return reopen === undefined ? store : asViewOf(reopen(session) as S, store);
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
    sessionHandoff: sessionId
      ? readLatestHandoff(db, { tenantId, sessionId, opts: {}, key })
      : null,
    recentSessionEvents: sessionId
      ? listSessionEvents(db, tenantId, { session_id: sessionId, limit: eventLimit })
      : [],
  };
}
