// The tenant lookup and global write behind `promote`, sync like the rest of LocalFiles so its audit row commits with
// the copy.

import type { MemoryEntry } from '../../core/memory.js';

/** How a promoted copy is written: the actor its `remember` row names and the local row it copies. */
export interface PromotedCopy {
  readonly actor?: string;
  readonly sourceId: string;
  /** Also writes one `promote` audit row for the copy ({sourceId}), in the copy's own transaction. */
  readonly auditAs?: { readonly tenantId: string; readonly actor: string };
}

export interface Promotion {
  /** The tenant and scope of the local memory, or undefined when no row has the id. */
  reach(id: string): { tenantId: string; scope: string | null } | undefined;
  /** Writes `copy` into this store, the global one; the caller has already vetted, labelled and embeds it. */
  writeCopy(copy: MemoryEntry, opts: PromotedCopy): void;
}
