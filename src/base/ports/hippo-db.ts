// hippo.db's local tier: the features only this store serves. No other store implements them, so
// none is part of the store port; the SQLite adapter builds them and src/api's local modules take them.
import type { AgentImport } from '../records/agent-import.js';
import type { AuditMaintenance } from '../records/audit-maintenance.js';
import type { Captures, CompactionHooks, Compactions } from '../records/capture.js';
import type { Cards } from '../records/cards.js';
import type { Conflicts } from '../records/conflicts.js';
import type { ConnectorEvents, ConnectorWrites } from '../records/connectors.js';
import type { Consolidation } from '../records/consolidation.js';
import type { DagReads } from '../records/dag-reads.js';
import type { Diagnostics, Readiness } from '../records/diagnostics.js';
import type { Dormant } from '../records/dormant.js';
import type { EmbeddingIndex } from '../records/embedding-index.js';
import type { FolderFiles } from '../records/folder-files.js';
import type { Goals } from '../records/goals.js';
import type { GraphReads, GraphRebuild } from '../records/graph.js';
import type { LastRecall } from '../records/last-recall.js';
import type { Learning } from '../records/learning.js';
import type { Ledger } from '../records/ledger.js';
import type { LessonWrites } from '../records/lesson-writes.js';
import type { Objects } from '../records/objects.js';
import type { ProjectTags } from '../records/project-tags.js';
import type { Quarantine } from '../records/quarantine.js';
import type { FailureLog, Rejections } from '../records/rejections.js';
import type { Reports } from '../records/reports.js';
import type { Sessions } from '../records/sessions.js';
import type { Promotion, Sharing } from '../records/sharing.js';
import type { HippoStore } from './store.js';

/** The store-wide counters a local write moves, beside the rows it wrote. */
export interface Stats {
  /** Adds `count` to the one store-wide remembered counter, no tenant. Its rows have committed, so
   * a busy store never fails the write; a store runtime holds the count. */
  bumpRemembered(count: number): Promise<void>;
}

export interface HippoDbRepos {
  readonly stats: Stats;
  readonly quarantine: Quarantine;
  readonly sessions: Sessions;
  readonly auditMaintenance: AuditMaintenance;
  readonly connectorWrites: ConnectorWrites;
  readonly connectorEvents: ConnectorEvents;
  readonly rejections: Rejections;
  readonly lastRecall: LastRecall;
  readonly reports: Reports;
  readonly conflicts: Conflicts;
  readonly promotion: Promotion;
  readonly lessonWrites: LessonWrites;
  readonly readiness: Readiness;
  readonly dagReads: DagReads;
  readonly graphReads: GraphReads;
  readonly graphRebuild: GraphRebuild;
  readonly ledger: Ledger;
  readonly folderFiles: FolderFiles;
  readonly sharing: Sharing;
  readonly consolidation: Consolidation;
  readonly learning: Learning;
  readonly dormant: Dormant;
  readonly captures: Captures;
  readonly compactionHooks: CompactionHooks;
  readonly compactions: Compactions;
  readonly failureLog: FailureLog;
  readonly projectTags: ProjectTags;
  readonly diagnostics: Diagnostics;
  readonly agentImport: AgentImport;
  readonly objects: Objects;
  readonly cards: Cards;
  readonly goals: Goals;
  readonly embeddingIndex: EmbeddingIndex;
}

/** A store that carries the local tier. */
export interface HippoDbTier {
  readonly hippoDb: HippoDbRepos;
}

/** hippo.db's own store: the core port and the local tier. */
export type HippoDbStore = HippoStore & HippoDbTier;
