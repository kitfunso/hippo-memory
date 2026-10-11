// Dormant memories: list, restore, forget and check.

import { ConflictError, NotFoundError } from '../core/api-errors.js';
import { stampOriginProject } from '../store/entry-row.js';
import { updateStatsUnlessBusy } from '../store/index-and-stats.js';
import {
  loadDormantMemories,
  holdsDormantMemory,
  restoreDormantMemory,
  forgetDormantMemory,
  type DormantMemory,
  type DormantSnapshot,
  type ListDormantOpts,
} from '../store/dormant.js';
import { createMemory, calculateStrength, type MemoryEntry } from '../core/memory.js';
import { loadConfig } from '../core/config.js';
import { canTouchScope, personalScopeOf } from '../core/recall-scope.js';
import { touchableScopeSql, type SqlFragment } from '../store/rule-sql.js';
import type { Context } from './types.js';

const touchable = (ctx: Context): SqlFragment => touchableScopeSql('', personalScopeOf(ctx.actor));

/** A tenant's dormant memories (src/store/dormant.ts): what sleep moved out of active memory when `dormant.enabled` is on. Newest first;
 * `opts.query` keeps rows containing every term (case-insensitive). */
export function listDormant(ctx: Context, opts: ListDormantOpts = {}): DormantMemory[] {
  return loadDormantMemories(ctx.hippoRoot, ctx.tenantId, opts, touchable(ctx));
}

/** Restores a dormant memory as if just recalled, with a full half-life; a row set aside by audit repair returns `verified`.
 * Throws if the tenant has no such dormant id or a live memory holds it, and RejectedValueError if the value was since rejected (the dormant copy stays). */
export function restoreDormant(ctx: Context, id: string): MemoryEntry {
  const outcome = restoreDormantMemory(ctx.hippoRoot, {
    tenantId: ctx.tenantId,
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
  // A snapshot can predate a field added later: createMemory supplies defaults, then the snapshot overrides every field it carries.
  // The placeholder content only meets createMemory's minimum length, so a legacy row under 3 chars still restores.
  const revived: MemoryEntry = {
    ...createMemory('dormant snapshot defaults', { baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays }),
    ...dormant.entry,
    last_retrieved: now.toISOString(),
  };
  if (dormant.reason === 'quality-repair') revived.confidence = 'verified';
  return stampOriginProject(ctx.hippoRoot, { ...revived, strength: calculateStrength(revived, now) });
}

/** Permanently deletes a dormant memory, the explicit "forget it for good"; throws when the tenant has no dormant memory with that id. */
export function forgetDormant(ctx: Context, id: string): void {
  const forgotten = forgetDormantMemory(ctx.hippoRoot, { tenantId: ctx.tenantId, id, actor: ctx.actor.subject, admit: touchable(ctx) });
  if (!forgotten) throw new NotFoundError(`dormant memory not found: ${id}`);
  // Counted like every other permanent removal (forget, archiveRaw).
  updateStatsUnlessBusy(ctx.hippoRoot, { forgotten: 1 }, `removed ${id}`);
}

/** Whether the tenant holds a dormant memory with this id that the caller may touch (for "not found" hints). */
export function isDormant(ctx: Context, id: string): boolean {
  return holdsDormantMemory(ctx.hippoRoot, ctx.tenantId, id, touchable(ctx));
}
