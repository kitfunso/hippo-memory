// The LocalFiles group, kept apart from port.ts so each SQLite-only member lands here.
import type { HippoStore } from '../port.js';
import type { AgentImport } from './agent-import.js';
import type { Consolidation } from './consolidation.js';
import type { Diagnostics } from './diagnostics.js';
import type { Learning } from './learning.js';
import type { Promotion } from './promotion.js';
import type { Sharing } from './sharing.js';

export type { AgentImport, ContainerTx, ImportTarget } from './agent-import.js';
export type { Consolidation } from './consolidation.js';
export type { Diagnostics } from './diagnostics.js';
export type { Learning } from './learning.js';
export type { Promotion } from './promotion.js';
export type { Sharing } from './sharing.js';

/** The store is hippo.db and its files under `hippoRoot`, so a path that reopens them by folder (sleep, its child
 * process, the global store) may run. */
export interface LocalFiles {
  readonly hippoRoot: string;
  readonly consolidation: Consolidation;
  readonly agentImport: AgentImport;
  readonly promotion: Promotion;
  readonly learning: Learning;
  readonly sharing: Sharing;
  readonly diagnostics: Diagnostics;
  /** The operator's global store, built at each call because a share may have to create it first. */
  globalStore(): HippoStore;
}
