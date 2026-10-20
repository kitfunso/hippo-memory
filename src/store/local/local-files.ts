// The local files a hippo.db root reads and writes in process, beside the port: synchronous, so a sleep pass or a
// hook's write scope never spans an await.
import type { AgentImport } from './agent-import.js';
import type { Captures } from './captures.js';
import type { CompactionHooks } from './compaction-hooks.js';
import type { Consolidation } from './consolidation.js';
import type { DashboardReads } from './dashboard-reads.js';
import type { Diagnostics } from './diagnostics.js';
import type { GraphRebuild } from './graph-rebuild.js';
import type { Learning } from './learning.js';
import type { ProjectTags } from './project-tags.js';
import type { RejectionCheck } from '../port/rejections.js';
import type { EntryTextKey } from '../port/sharing.js';
import type { TenantId } from '../../base/util/tenant.js';

export type { AgentImport, ContainerTx, ImportTarget } from './agent-import.js';
export type { Captures } from './captures.js';
export type { CompactionHooks } from './compaction-hooks.js';
export type { Consolidation } from './consolidation.js';
export type {
  ConflictPair,
  DashboardReads,
  DashboardRow,
  DashboardScan,
  DashboardText,
  ExcludedCounts,
} from './dashboard-reads.js';
export type { Diagnostics } from './diagnostics.js';
export type { GraphRebuild } from './graph-rebuild.js';
export type { Learning } from './learning.js';
export type { ProjectTags } from './project-tags.js';

/** The store is hippo.db and its files under a folder, so a path that reopens them by folder (sleep, its child process,
 * the global store) may run; the caller names that folder. */
export interface LocalFiles {
  /** Creates the store's files when they are missing, as `hippo init`, a first share or a global capture needs. */
  ensureFiles(): void;
  readonly consolidation: Consolidation;
  readonly agentImport: AgentImport;
  readonly captures: Captures;
  readonly compactionHooks: CompactionHooks;
  readonly projectTags: ProjectTags;
  readonly learning: Learning;
  readonly diagnostics: Diagnostics;
  readonly graphRebuild: GraphRebuild;
  readonly dashboard: DashboardReads;
  /** The rejected-value probe of a dry run that cannot await: the CLI's capture and the importers. */
  readonly rejections: { refusedAmong(checks: readonly RejectionCheck[]): boolean[] };
  /** The duplicate probe of the published importers, which stay synchronous. */
  readonly importKeys: { textKeysHolding(tenantId: TenantId, texts: readonly string[]): EntryTextKey[] };
}

/** hippo.db's files and the folder whose config.json governs them. */
export interface FolderFiles {
  readonly root: string;
  readonly files: LocalFiles;
}
