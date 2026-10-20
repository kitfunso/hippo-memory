// Pin or unpin a memory, so decay and sleep leave it alone.

import type { MemoryEntry } from '../../base/memory/memory.js';
import { personalScopeOf } from '../../base/scope/recall-scope.js';
import type { Context } from '../types.js';

/** A row out of reach answers as not found, as forget does, so a caller learns nothing about it. */
export async function memoryPin(ctx: Context, id: string, pinned: boolean): Promise<MemoryEntry> {
  return ctx.store.entryWrites.setPinned({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ownScope: personalScopeOf(ctx.actor),
    id,
    pinned,
  });
}
