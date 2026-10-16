// The local-to-global copy behind `promote`, sync like the rest of LocalFiles so its audit row commits with the copy.

import type { MemoryEntry } from '../../core/memory.js';

export interface PromoteOptions {
  actor?: string;
  tenantId?: string;
  /** Also writes one `promote` audit row for the copy ({sourceId}), in the copy's own transaction. */
  auditAs?: { tenantId: string; actor: string };
}

export interface Promotion {
  /** The tenant and scope of the local memory, or undefined when no row has the id. */
  reach(id: string): { tenantId: string; scope: string | null } | undefined;
  /** Copies the local memory into the global store as a new `g_` row; the caller embeds the copy. */
  copyToGlobal(id: string, opts: PromoteOptions): MemoryEntry;
}
