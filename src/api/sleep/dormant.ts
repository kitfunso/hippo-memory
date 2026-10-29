// Dormant memories: list, restore, forget and check.

import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import type { DormantMemory, ListDormantOptions } from '../../base/ports/store/dormant.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { personalScopeOf } from '../../base/scope/recall-scope.js';
import { strengthOf, type ContextWith } from '../types.js';

/**
 * A tenant's dormant memories (sqlite/dormant/dormant.ts): what sleep moved out of active memory when
 * `dormant.enabled` is on. Newest first; `opts.query` keeps rows containing every term
 * (case-insensitive). */
export function dormantList(
  ctx: ContextWith<'dormant'>,
  opts: ListDormantOptions = {},
): Promise<DormantMemory[]> {
  return ctx.store.hippoDb.dormant.list(ctx.tenantId, personalScopeOf(ctx.actor), opts);
}

/**
 * Restores a dormant memory as if just recalled, with a full half-life; a row set aside by audit
 * repair returns `verified`. Throws if the tenant has no such dormant id or a live memory holds it,
 * and RejectedValueError if the value was since rejected (the dormant copy stays).
 */
export async function dormantRestore(
  ctx: ContextWith<'dormant'>,
  id: string,
): Promise<MemoryEntry> {
  const outcome = await ctx.store.hippoDb.dormant.restore(ctx.tenantId, {
    id,
    actor: ctx.actor.subject,
    ownScope: personalScopeOf(ctx.actor),
    revival: { halfLifeDays: ctx.config.defaultHalfLifeDays, strength: strengthOf(ctx) },
  });
  if (outcome.status === 'missing') throw new NotFoundError(`dormant memory not found: ${id}`);
  if (outcome.status === 'active') {
    throw new ConflictError(
      `memory ${id} is already active; forget it before restoring its dormant copy`,
    );
  }
  return outcome.entry;
}

/**
 * Permanently deletes a dormant memory, the explicit "forget it for good"; throws when the tenant
 * has no dormant memory with that id.
 */
export async function dormantForget(ctx: ContextWith<'dormant'>, id: string): Promise<void> {
  const forgotten = await ctx.store.hippoDb.dormant.forget(
    ctx.tenantId,
    personalScopeOf(ctx.actor),
    id,
    ctx.actor.subject,
  );
  if (!forgotten) throw new NotFoundError(`dormant memory not found: ${id}`);
}

/** Whether the tenant holds a dormant memory with this id that the caller may touch (for "not
 * found" hints). */
export async function isDormant(ctx: ContextWith<'dormant'>, id: string): Promise<boolean> {
  return (
    (
      await ctx.store.hippoDb.dormant.list(ctx.tenantId, personalScopeOf(ctx.actor), {
        id,
        limit: 1,
      })
    ).length > 0
  );
}
