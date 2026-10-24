// Pin or unpin a memory, so decay and sleep leave it alone.

import type { MemoryEntry } from '../../base/memory/memory.js';
import { scopeReaderOf } from '../../base/scope/recall-scope.js';
import type { Context } from '../types.js';

/** A row out of reach answers as not found and a reached row the caller may not change answers 403, as forget does. */
export async function memoryPin(ctx: Context, id: string, pinned: boolean): Promise<MemoryEntry> {
  return ctx.store.entryWrites.setPinned({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    id,
    pinned,
  });
}
