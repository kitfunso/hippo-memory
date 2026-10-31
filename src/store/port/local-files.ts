// The LocalFiles group, kept apart from port.ts so each SQLite-only member lands here.
import type { AgentImport } from './agent-import.js';
import type { Consolidation } from './consolidation.js';
import type { Learning } from './learning.js';
import type { Promotion } from './promotion.js';

export type { AgentImport, ContainerTx, ImportTarget } from './agent-import.js';
export type { Consolidation } from './consolidation.js';
export type { Learning } from './learning.js';
export type { Promotion } from './promotion.js';

/** The store is hippo.db and its files under `hippoRoot`, so a path that reopens them by folder (sleep, its child
 * process, the global store) may run. */
export interface LocalFiles {
  readonly hippoRoot: string;
  readonly consolidation: Consolidation;
  readonly agentImport: AgentImport;
  readonly promotion: Promotion;
  readonly learning: Learning;
}
