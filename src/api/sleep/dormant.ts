// Dormant memories: list, restore, forget and check.

import { ConflictError, NotFoundError } from '../../core/api-errors.js';
import { stampOriginProject } from '../../store/entry-row.js';
import type { DormantMemory, DormantSnapshot, ListDormantOpts } from '../../store/dormant.js';
import { strengthAblation } from '../../core/ablation.js';
import { createMemory, calculateStrength, type MemoryEntry } from '../../core/memory.js';
import { configOf } from '../config-of.js';
import { canTouchScope, personalScopeOf } from '../../core/recall-scope.js';
import type { Context, ContextWith } from '../types.js';

type DormantContext = ContextWith<'dormant'>;

/**
 * A tenant's dormant memories (src/store/dormant.ts): what sleep moved out of active memory when `dormant.enabled` is
 * on. Newest first;
 * `opts.query` keeps rows containing every term (case-insensitive). */
export function listDormant(ctx: DormantContext, opts: ListDormantOpts = {}): Promise<DormantMemory[]> {
  return ctx.store.dormant.list(ctx.tenantId, personalScopeOf(ctx.actor), opts);
}

/**
 * Restores a dormant memory as if just recalled, with a full half-life; a row set aside by audit repair returns
 * `verified`.
 * Throws if the tenant has no such dormant id or a live memory holds it, and RejectedValueError if the value was since
 * rejected (the dormant copy stays).
 */
export async function restoreDormant(ctx: DormantContext, id: string): Promise<MemoryEntry> {
  const outcome = await ctx.store.dormant.restore(ctx.tenantId, {
    id,
    actor: ctx.actor.subject,
    inReach: (scope) => canTouchScope(ctx.actor, scope),
    revive: (snapshot, now) => reviveSnapshot(ctx, snapshot, now),
  });
  if (outcome.status === 'missing') throw new NotFoundError(`dormant memory not found: ${id}`);
  if (outcome.status === 'active') {
    throw new ConflictError(`memory ${id} is already active; forget it before restoring its dormant copy`);
  }
  return outcome.entry;
}

function reviveSnapshot(ctx: Context, dormant: DormantSnapshot, now: Date): MemoryEntry {
  // A snapshot can predate a field added later: createMemory supplies defaults, then the snapshot overrides every field
  // it carries.
  // The placeholder content only meets createMemory's minimum length, so a legacy row under 3 chars still restores.
  const revived: MemoryEntry = {
    ...createMemory('dormant snapshot defaults', { baseHalfLifeDays: configOf(ctx).defaultHalfLifeDays }),
    ...dormant.entry,
    last_retrieved: now.toISOString(),
  };
  if (dormant.reason === 'quality-repair') revived.confidence = 'verified';
  return stampOriginProject(ctx.hippoRoot, {
    ...revived,
    strength: calculateStrength(revived, now, { ablation: strengthAblation() }),
  });
}

/**
 * Permanently deletes a dormant memory, the explicit "forget it for good"; throws when the tenant has no dormant memory
 * with that id.
 */
export async function forgetDormant(ctx: DormantContext, id: string): Promise<void> {
  const forgotten = await ctx.store.dormant.forget(ctx.tenantId, personalScopeOf(ctx.actor), id, ctx.actor.subject);
  if (!forgotten) throw new NotFoundError(`dormant memory not found: ${id}`);
}

/** Whether the tenant holds a dormant memory with this id that the caller may touch (for "not found" hints). */
export function isDormant(ctx: DormantContext, id: string): Promise<boolean> {
  return ctx.store.dormant.holds(ctx.tenantId, personalScopeOf(ctx.actor), id);
}
