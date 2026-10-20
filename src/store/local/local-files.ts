// The local files a hippo.db root reads and writes in process, beside the port: synchronous, so a sleep pass or a
// hook's write scope never spans an await.
import type { AgentImport } from '../port/agent-import.js';
import type { Captures } from '../port/captures.js';
import type { CompactionHooks } from '../port/compaction-hooks.js';
import type { Consolidation } from '../port/consolidation.js';
import type { Diagnostics } from '../port/diagnostics.js';
import type { GraphRebuild } from '../port/graph-rebuild.js';
import type { Learning } from '../port/learning.js';
import type { ProjectTags } from '../port/project-tags.js';
import type { RejectionCheck } from '../port/rejections.js';
import type { EntryTextKey } from '../port/sharing.js';
import type { TenantId } from '../../base/util/tenant.js';

export type { AgentImport, ContainerTx, ImportTarget } from '../port/agent-import.js';
export type { Captures } from '../port/captures.js';
export type { CompactionHooks } from '../port/compaction-hooks.js';
export type { Consolidation } from '../port/consolidation.js';
export type { Diagnostics } from '../port/diagnostics.js';
export type { GraphRebuild } from '../port/graph-rebuild.js';
export type { Learning } from '../port/learning.js';
export type { ProjectTags } from '../port/project-tags.js';

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
