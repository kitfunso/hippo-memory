// hippo.db's local tier: the features only this store serves, as repositories typed by their SQL
// bodies. No other store implements them, so none is part of the store port.
import { sqliteAgentImport } from './maintenance/agent-import.js';
import { AGENT_IMPORT_EFFECTS } from '../../base/ports/store/agent-import.js';
import { sqliteDiagnostics } from './maintenance/diagnostics.js';
import { sqliteProjectTags } from './maintenance/project-tags.js';
import { PROJECT_TAGS_EFFECTS } from '../../base/ports/store/project-tags.js';
import { sqliteFailureLog } from './capture/failure-log.js';
import { sqliteCompactions } from './capture/compactions.js';
import { sqliteCompactionHooks } from './capture/compaction-hooks.js';
import { sqliteCaptures } from './capture/captures.js';
import {
  CAPTURES_EFFECTS,
  COMPACTION_HOOKS_EFFECTS,
  COMPACTIONS_EFFECTS,
} from '../../base/ports/store/capture.js';
import { sqliteDormant } from './dormant/dormant.js';
import { DORMANT_EFFECTS } from '../../base/ports/store/dormant.js';
import { sqliteLearning } from './learning/learning.js';
import { LEARNING_EFFECTS } from '../../base/ports/store/learning.js';
import { sqliteConsolidation } from './consolidation/consolidation.js';
import { CONSOLIDATION_EFFECTS } from '../../base/ports/store/consolidation.js';
import { sqliteSharing } from './sharing/sharing.js';
import { sqliteFolderFiles } from './folder-files/folder-files.js';
import { FOLDER_FILES_EFFECTS } from '../../base/ports/store/folder-files.js';
import { sqliteLedger } from './ledger/ledger.js';
import { LEDGER_EFFECTS } from '../../base/ports/store/ledger.js';
import { sqliteGraphRebuild } from './graph/graph-rebuild.js';
import { sqliteGraphReads } from './graph/graph-reads.js';
import { GRAPH_READS_EFFECTS, GRAPH_REBUILD_EFFECTS } from '../../base/ports/store/graph.js';
import { sqliteDagReads } from './graph/dag-reads.js';
import { DAG_READS_EFFECTS } from '../../base/ports/store/context-reads.js';
import { sqliteReadiness } from './maintenance/readiness.js';
import { READINESS_EFFECTS, DIAGNOSTICS_EFFECTS } from '../../base/ports/store/diagnostics.js';
import { sqliteLessonWrites } from './learning/lesson-writes.js';
import { LESSON_WRITES_EFFECTS } from '../../base/ports/store/entry-writes.js';
import { sqlitePromotion } from './sharing/promotion.js';
import { PROMOTION_EFFECTS, SHARING_EFFECTS } from '../../base/ports/store/sharing.js';
import { sqliteConflicts } from './review/conflicts.js';
import { CONFLICTS_EFFECTS } from '../../base/ports/store/conflicts.js';
import { sqliteReports } from './reports/reports.js';
import { REPORTS_EFFECTS } from '../../base/ports/store/reports.js';
import { sqliteLastRecall } from './recall/last-recall.js';
import { LAST_RECALL_EFFECTS } from '../../base/ports/store/recall-writes.js';
import { sqliteRejections } from './review/rejections.js';
import { REJECTIONS_EFFECTS, FAILURE_LOG_EFFECTS } from '../../base/ports/store/rejections.js';
import { sqliteConnectorEvents } from './connectors/connector-events.js';
import { sqliteConnectorWrites } from './connectors/connector-writes.js';
import {
  CONNECTOR_WRITES_EFFECTS,
  CONNECTOR_EVENTS_EFFECTS,
} from '../../base/ports/store/connectors.js';
import { AUDIT_MAINTENANCE_EFFECTS } from '../../base/ports/store/audit.js';
import { sqliteAuditMaintenance } from './audit/audit-maintenance.js';
import type { HippoStore, StoreGroups } from '../../base/ports/store.js';
import type { MethodEffects } from '../../base/ports/store/effects.js';
import { SESSIONS_EFFECTS } from '../../base/ports/store/sessions.js';
import { sqliteQuarantine } from './connectors/quarantine.js';
import { sqliteStats } from './entries/index-and-stats.js';
import { sqliteSessions } from './sessions/sessions.js';
import type { Handles } from './runtime/open.js';

/** Every local repository on `handles`; the SQLite store carries them as `hippoDb`. */
export function hippoDbRepos(handles: Handles) {
  return {
    stats: sqliteStats(handles),
    quarantine: sqliteQuarantine(handles),
    sessions: sqliteSessions(handles),
    auditMaintenance: sqliteAuditMaintenance(handles),
    connectorWrites: sqliteConnectorWrites(handles),
    connectorEvents: sqliteConnectorEvents(handles.on),
    rejections: sqliteRejections(handles),
    lastRecall: sqliteLastRecall(handles),
    reports: sqliteReports(handles),
    conflicts: sqliteConflicts(handles),
    promotion: sqlitePromotion(handles),
    lessonWrites: sqliteLessonWrites(handles),
    readiness: sqliteReadiness(handles),
    dagReads: sqliteDagReads(handles.on),
    graphReads: sqliteGraphReads(handles.on),
    graphRebuild: sqliteGraphRebuild(handles.on),
    ledger: sqliteLedger(handles.on, handles.files.opens.grant.session),
    folderFiles: sqliteFolderFiles(handles),
    sharing: sqliteSharing(handles.on),
    consolidation: sqliteConsolidation(handles),
    learning: sqliteLearning(handles),
    dormant: sqliteDormant(handles),
    captures: sqliteCaptures(handles),
    compactionHooks: sqliteCompactionHooks(handles),
    compactions: sqliteCompactions(handles),
    failureLog: sqliteFailureLog(handles.on),
    projectTags: sqliteProjectTags(handles),
    diagnostics: sqliteDiagnostics(handles.on),
    agentImport: sqliteAgentImport(handles),
  };
}

export type HippoDbRepos = ReturnType<typeof hippoDbRepos>;

/** A store that carries the local tier. */
export interface HippoDbTier {
  readonly hippoDb: HippoDbRepos;
}

/** hippo.db's own store: the port with every optional group, and the local tier. */
export type HippoDbStore = HippoStore & StoreGroups & HippoDbTier;

/** What each local method does to the store, which places it on a worker; a method missing here
 * fails to compile. */
export const HIPPO_DB_EFFECTS = {
  stats: { bumpRemembered: 'write' },
  quarantine: { list: 'read', approve: 'write', reject: 'write' },
  sessions: SESSIONS_EFFECTS,
  auditMaintenance: AUDIT_MAINTENANCE_EFFECTS,
  connectorWrites: CONNECTOR_WRITES_EFFECTS,
  connectorEvents: CONNECTOR_EVENTS_EFFECTS,
  rejections: REJECTIONS_EFFECTS,
  lastRecall: LAST_RECALL_EFFECTS,
  reports: REPORTS_EFFECTS,
  conflicts: CONFLICTS_EFFECTS,
  promotion: PROMOTION_EFFECTS,
  lessonWrites: LESSON_WRITES_EFFECTS,
  readiness: READINESS_EFFECTS,
  dagReads: DAG_READS_EFFECTS,
  graphReads: GRAPH_READS_EFFECTS,
  graphRebuild: GRAPH_REBUILD_EFFECTS,
  ledger: LEDGER_EFFECTS,
  folderFiles: FOLDER_FILES_EFFECTS,
  sharing: SHARING_EFFECTS,
  consolidation: CONSOLIDATION_EFFECTS,
  learning: LEARNING_EFFECTS,
  dormant: DORMANT_EFFECTS,
  captures: CAPTURES_EFFECTS,
  compactionHooks: COMPACTION_HOOKS_EFFECTS,
  compactions: COMPACTIONS_EFFECTS,
  failureLog: FAILURE_LOG_EFFECTS,
  projectTags: PROJECT_TAGS_EFFECTS,
  diagnostics: DIAGNOSTICS_EFFECTS,
  agentImport: AGENT_IMPORT_EFFECTS,
} as const satisfies { readonly [R in keyof HippoDbRepos]: MethodEffects<HippoDbRepos[R]> };
