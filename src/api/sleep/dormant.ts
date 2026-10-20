// Dormant memories: list, restore, forget and check.

import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import type { DormantMemory, ListDormantOpts } from '../../store/port/dormant.js';
import { strengthOptionsOf, type MemoryEntry } from '../../base/memory/memory.js';
import { personalScopeOf } from '../../base/scope/recall-scope.js';
import type { Context } from '../types.js';

/**
 * A tenant's dormant memories (src/store/dormant.ts): what sleep moved out of active memory when `dormant.enabled` is
 * on. Newest first; `opts.query` keeps rows containing every term (case-insensitive). */
export function dormantList(ctx: Context, opts: ListDormantOpts = {}): Promise<DormantMemory[]> {
  return ctx.store.dormant.list(ctx.tenantId, personalScopeOf(ctx.actor), opts);
}

/**
 * Restores a dormant memory as if just recalled, with a full half-life; a row set aside by audit repair returns
 * `verified`.
 * Throws if the tenant has no such dormant id or a live memory holds it, and RejectedValueError if the value was since
 * rejected (the dormant copy stays).
 */
export async function dormantRestore(ctx: Context, id: string): Promise<MemoryEntry> {
  const outcome = await ctx.store.dormant.restore(ctx.tenantId, {
    id,
    actor: ctx.actor.subject,
    ownScope: personalScopeOf(ctx.actor),
    revival: { halfLifeDays: ctx.config.defaultHalfLifeDays, strength: strengthOptionsOf(ctx.config.runtime) },
  });
  if (outcome.status === 'missing') throw new NotFoundError(`dormant memory not found: ${id}`);
  if (outcome.status === 'active') {
    throw new ConflictError(`memory ${id} is already active; forget it before restoring its dormant copy`);
  }
  return outcome.entry;
}

/**
 * Permanently deletes a dormant memory, the explicit "forget it for good"; throws when the tenant has no dormant memory
 * with that id.
 */
export async function dormantForget(ctx: Context, id: string): Promise<void> {
  const forgotten = await ctx.store.dormant.forget(ctx.tenantId, personalScopeOf(ctx.actor), id, ctx.actor.subject);
  if (!forgotten) throw new NotFoundError(`dormant memory not found: ${id}`);
}

/** Whether the tenant holds a dormant memory with this id that the caller may touch (for "not found" hints). */
export function isDormant(ctx: Context, id: string): Promise<boolean> {
  return ctx.store.dormant.holds(ctx.tenantId, personalScopeOf(ctx.actor), id);
}
