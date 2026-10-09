// Dormant memories: list, restore, forget and check.

import { ConflictError, NotFoundError } from '../api-errors.js';
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
import { createMemory, calculateStrength, type MemoryEntry } from '../memory.js';
import { loadConfig } from '../config.js';
import { canTouchScope, personalScopeOf, touchableScopeSql, type SqlFragment } from '../recall-scope.js';
import type { Context } from './types.js';

const touchable = (ctx: Context): SqlFragment => touchableScopeSql('', personalScopeOf(ctx.actor));

/**
 * A tenant's dormant memories (src/store/dormant.ts): what sleep moved out of
 * active memory instead of deleting, when `dormant.enabled` is on. Newest
 * first; `opts.query` keeps rows containing every term (case-insensitive).
 */
export function listDormant(ctx: Context, opts: ListDormantOpts = {}): DormantMemory[] {
  return loadDormantMemories(ctx.hippoRoot, ctx.tenantId, opts, touchable(ctx));
}

/**
 * Bring a dormant memory back into active memory. It returns as if just
 * recalled, with a full half-life. A row audit repair set aside returns
 * `verified`, so no quality check judges it again. Every other field is the
 * snapshot taken when it went dormant.
 *
 * Throws when the tenant has no dormant memory with that id (another
 * tenant's id, or another person's personal row, reads the same way), when a live memory already holds the id,
 * and RejectedValueError when the value has been rejected since. On any
 * throw the dormant copy stays where it is.
 */
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
  // Dormant rows are long-lived, so a snapshot can predate a field added
  // later: createMemory supplies a default for anything it lacks, then
  // the snapshot overrides every field it does carry, content included.
  // (The placeholder only satisfies createMemory's minimum length, so a
  // legacy row shorter than 3 chars can still be restored.)
  const revived: MemoryEntry = {
    ...createMemory('dormant snapshot defaults', { baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays }),
    ...dormant.entry,
    last_retrieved: now.toISOString(),
  };
  if (dormant.reason === 'quality-repair') revived.confidence = 'verified';
  return stampOriginProject(ctx.hippoRoot, { ...revived, strength: calculateStrength(revived, now) });
}

/**
 * Permanently delete a dormant memory: the explicit "forget it for good"
 * that dormant storage leaves to the user. Throws when the tenant has no
 * dormant memory with that id.
 */
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
