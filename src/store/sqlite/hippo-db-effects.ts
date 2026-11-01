// What each method of hippo.db's local tier does to the store, which places it on a worker.

import type { MethodEffects } from '../../base/ports/store/types.js';
import type { AgentImport } from '../../base/records/agent-import.js';
import type { Captures, CompactionHooks, Compactions } from '../../base/records/capture.js';
import type { Cards } from '../../base/records/cards.js';
import type { Conflicts } from '../../base/records/conflicts.js';
import type { ConnectorEvents, ConnectorWrites } from '../../base/records/connectors.js';
import type { Consolidation } from '../../base/records/consolidation.js';
import type { Diagnostics, Readiness } from '../../base/records/diagnostics.js';
import type { Dormant } from '../../base/records/dormant.js';
import type { FolderFiles } from '../../base/records/folder-files.js';
import type { Goals } from '../../base/records/goals.js';
import type { GraphReads, GraphRebuild } from '../../base/records/graph.js';
import type { Learning } from '../../base/records/learning.js';
import type { Ledger } from '../../base/records/ledger.js';
import type { Objects } from '../../base/records/objects.js';
import type { ProjectTags } from '../../base/records/project-tags.js';
import type { Rejections, FailureLog } from '../../base/records/rejections.js';
import type { Reports } from '../../base/records/reports.js';
import type { Sessions } from '../../base/records/sessions.js';
import type { Sharing, Promotion } from '../../base/records/sharing.js';
import type { DagReads } from '../../base/records/dag-reads.js';
import type { AuditMaintenance } from '../../base/records/audit-maintenance.js';
import type { LessonWrites } from '../../base/records/lesson-writes.js';
import type { EmbeddingIndex } from '../../base/records/embedding-index.js';
import type { LastRecall } from '../../base/records/last-recall.js';

/** What each AgentImport method does to hippo.db. */
export const AGENT_IMPORT_EFFECTS = {
  applyContainer: 'write',
} as const satisfies MethodEffects<AgentImport>;

/** What each Captures method does to hippo.db. */
export const CAPTURES_EFFECTS = {
  write: 'write',
  textsHolding: 'read',
} as const satisfies MethodEffects<Captures>;

/** What each CompactionHooks method does to hippo.db. */
export const COMPACTION_HOOKS_EFFECTS = {
  start: 'write',
  markSnapshotSaved: 'write',
  save: 'write',
  saveStalled: 'write',
  recordSpooled: 'write',
  saveRecordItems: 'write',
  openRecords: 'read',
  fill: 'write',
} as const satisfies MethodEffects<CompactionHooks>;

/** What each Compactions method does to hippo.db. */
export const COMPACTIONS_EFFECTS = {
  start: 'write',
  markSnapshotSaved: 'write',
  saveCallerItems: 'write',
} as const satisfies MethodEffects<Compactions>;

/** What each Cards method does to hippo.db. */
export const CARDS_EFFECTS = {
  create: 'write',
  detail: 'read',
  list: 'read',
  claim: 'write',
  heartbeat: 'write',
  block: 'write',
  review: 'write',
  complete: 'write',
  reclaimExpired: 'write',
  comment: 'write',
} as const satisfies MethodEffects<Cards>;

/** What each Conflicts method does to hippo.db. */
export const CONFLICTS_EFFECTS = {
  list: 'read',
  get: 'read',
  resolve: 'write',
} as const satisfies MethodEffects<Conflicts>;

/** What each ConnectorEvents method does to hippo.db. */
export const CONNECTOR_EVENTS_EFFECTS = {
  eventRecord: 'read',
  markEventSeen: 'write',
  claimDelivery: 'write',
  releaseDelivery: 'write',
  route: 'read',
  parkDeadLetter: 'write',
  deadLetters: 'read',
  markDeadLetterRetried: 'write',
  cursor: 'read',
  saveCursor: 'write',
  slackWorkspaces: 'read',
  registerSlackWorkspace: 'write',
  removeSlackWorkspace: 'write',
} as const satisfies MethodEffects<ConnectorEvents>;

/** What each ConnectorWrites method does to hippo.db. */
export const CONNECTOR_WRITES_EFFECTS = {
  writeConnectorEntry: 'write',
  archiveConnectorEntry: 'write',
} as const satisfies MethodEffects<ConnectorWrites>;

/** What each Consolidation method does to hippo.db. */
export const CONSOLIDATION_EFFECTS = {
  begin: 'write',
  entryIdsPage: 'read',
  rejected: 'read',
  dirtySummaries: 'read',
  unprofiledTopicSummaries: 'read',
  settleSummary: 'write',
  commit: 'write',
  recordSleep: 'write',
  auditEachRow: 'write',
  duplicateCandidates: 'read',
  dirtyGraphTenants: 'read',
  markGraphDrained: 'write',
} as const satisfies MethodEffects<Consolidation>;

/** What each Diagnostics method does to hippo.db. */
export const DIAGNOSTICS_EFFECTS = {
  health: 'read',
  inventory: 'read',
} as const satisfies MethodEffects<Diagnostics>;

/** What each Readiness method does to hippo.db. */
export const READINESS_EFFECTS = {
  ping: 'read',
} as const satisfies MethodEffects<Readiness>;

/** What each Dormant method does to hippo.db. */
export const DORMANT_EFFECTS = {
  list: 'read',
  restore: 'write',
  forget: 'write',
} as const satisfies MethodEffects<Dormant>;

/** What each FolderFiles method does to hippo.db. */
export const FOLDER_FILES_EFFECTS = {
  ensure: 'write',
  home: 'read',
} as const satisfies MethodEffects<FolderFiles>;

/** What each Goals method does to hippo.db. */
export const GOALS_EFFECTS = {
  push: 'write',
  sessionGoals: 'read',
  complete: 'write',
  suspend: 'write',
  resume: 'write',
} as const satisfies MethodEffects<Goals>;

/** What each GraphReads method does to hippo.db. */
export const GRAPH_READS_EFFECTS = {
  graphRows: 'read',
  graphDelta: 'read',
} as const satisfies MethodEffects<GraphReads>;

/** What each GraphRebuild method does to hippo.db. */
export const GRAPH_REBUILD_EFFECTS = {
  applyOps: 'write',
} as const satisfies MethodEffects<GraphRebuild>;

/** What each Learning method does to hippo.db. */
export const LEARNING_EFFECTS = {
  entriesMentioning: 'read',
  readEntry: 'read',
  addTagToEntries: 'write',
  confirmedOutcomeTimes: 'read',
} as const satisfies MethodEffects<Learning>;

/** What each Ledger method does to hippo.db. */
export const LEDGER_EFFECTS = {
  recordTurn: 'write',
  lastSent: 'read',
  pilotArm: 'write',
  replaceRereads: 'write',
} as const satisfies MethodEffects<Ledger>;

/** What each Objects method does to hippo.db. */
export const OBJECTS_EFFECTS = {
  listObjects: 'read',
  objectById: 'read',
  closeObject: 'write',
  saveObject: 'write',
  briefReceipts: 'read',
  predictionBaserate: 'write',
} as const satisfies MethodEffects<Objects>;

/** What each ProjectTags method does to hippo.db. */
export const PROJECT_TAGS_EFFECTS = {
  originTallies: 'read',
  dormantWhere: 'read',
  compactionOrigins: 'read',
  merge: 'write',
  repair: 'write',
  repairedOnce: 'read',
  markRepairedOnce: 'write',
} as const satisfies MethodEffects<ProjectTags>;

/** What each Rejections method does to hippo.db. */
export const REJECTIONS_EFFECTS = {
  apply: 'write',
  lift: 'write',
  list: 'read',
  refusedAmong: 'read',
} as const satisfies MethodEffects<Rejections>;

/** What each FailureLog method does to hippo.db. */
export const FAILURE_LOG_EFFECTS = {
  record: 'write',
  requestOutcome: 'read',
  settleOutcome: 'write',
} as const satisfies MethodEffects<FailureLog>;

/** What each Reports method does to hippo.db. */
export const REPORTS_EFFECTS = {
  tokenUse: 'read',
  failures: 'read',
  memoryStatus: 'read',
  countEntries: 'read',
  stats: 'read',
  statusCounts: 'read',
  correctionLinks: 'read',
  rawProvenance: 'read',
  createdSinceLastSleep: 'read',
} as const satisfies MethodEffects<Reports>;

/** What each Sessions method does to hippo.db. */
export const SESSIONS_EFFECTS = {
  save: 'write',
  read: 'read',
  clear: 'write',
  loadSnapshot: 'read',
  bindSessionOwner: 'write',
} as const satisfies MethodEffects<Sessions>;

/** What each Sharing method does to hippo.db. */
export const SHARING_EFFECTS = {
  entriesWithSignals: 'read',
  textKeysPage: 'read',
  textKeysHolding: 'read',
  takenIds: 'read',
  sourceTallies: 'read',
  searchEntries: 'read',
  recallEntries: 'read',
} as const satisfies MethodEffects<Sharing>;

/** What each Promotion method does to hippo.db. */
export const PROMOTION_EFFECTS = {
  writeCopy: 'write',
} as const satisfies MethodEffects<Promotion>;

/** What each DagReads method does to hippo.db. */
export const DAG_READS_EFFECTS = {
  sessionRawCount: 'read',
  sessionRawKeys: 'read',
  sessionRawRows: 'read',
  summaryWithDescendants: 'read',
} as const satisfies MethodEffects<DagReads>;

/** What each AuditMaintenance method does to hippo.db. */
export const AUDIT_MAINTENANCE_EFFECTS = {
  objectBackedAmong: 'read',
  deleteAutomatically: 'write',
  pruneAuditRows: 'write',
  repairQuality: 'write',
  repairQualityOnce: 'write',
} as const satisfies MethodEffects<AuditMaintenance>;

/** What each LessonWrites method does to hippo.db. */
export const LESSON_WRITES_EFFECTS = {
  textsHolding: 'read',
  contentsWithTag: 'read',
  writeSkippingRejected: 'write',
  writeTogether: 'write',
} as const satisfies MethodEffects<LessonWrites>;

/** What each EmbeddingIndex method does to hippo.db. */
export const EMBEDDING_INDEX_EFFECTS = {
  open: 'read',
  step: 'write',
} as const satisfies MethodEffects<EmbeddingIndex>;

/** What each LastRecall method does to hippo.db. */
export const LAST_RECALL_EFFECTS = {
  applyOutcomeToLast: 'write',
  finishRecall: 'write',
} as const satisfies MethodEffects<LastRecall>;
