// The global write behind `promote`, which answers through a Promise so a served store runs it on its writer thread.

import type { MemoryEntry } from '../../core/memory.js';

/** How a promoted copy is written: the actor its `remember` row names and the local row it copies. */
export interface PromotedCopy {
  readonly actor?: string;
  readonly sourceId: string;
  /** Also writes one `promote` audit row for the copy ({sourceId}), in the copy's own transaction. */
  readonly auditAs?: { readonly tenantId: string; readonly actor: string };
}

export interface Promotion {
  /** Writes `copy` into this store, the global one; the caller has already vetted, labelled and embeds it. */
  writeCopy(copy: MemoryEntry, opts: PromotedCopy): Promise<void>;
}
