// Conflict resolution for every front end, so the reach, status, pair and liveness checks live in one place.
// SHORTCUT: hippo.db only, since the store port has no conflict calls; a conflicts group when a served store needs them.
import { BadRequestError, ConflictError, NotFoundError } from '../core/api-errors.js';
import type { MemoryEntry } from '../core/memory.js';
import { listTouchableConflicts, resolveConflict } from '../store/conflicts.js';
import { loadEntriesByIds } from '../store/entry-reads.js';
import { isQuarantineScope } from '../trust/quarantine.js';
import type { Context } from './types.js';

export interface ResolveMemoryConflictOpts {
  /** One of the conflict's two memories; the other is the loser. */
  keepId: string;
  /** Delete the loser instead of halving its half-life. */
  forget?: boolean;
  /** Tombstone the loser's value as well, which removes it whatever `forget` says. */
  rejectLoser?: boolean;
  /** Kept on the tombstone; a conflict-context reason when unset. */
  reason?: string;
}

export interface ResolveMemoryConflictResult {
  conflictId: number;
  keptId: string;
  loserId: string;
}

function isLive(entry: Pick<MemoryEntry, 'superseded_by' | 'kind' | 'scope'>): boolean {
  return !entry.superseded_by && (entry.kind === 'raw' || entry.kind === 'distilled') && !isQuarantineScope(entry.scope);
}

/** Keeps `keepId` and weakens, deletes or rejects the other side of an open conflict in the caller's tenant, auditing as `ctx.actor`.
 *  NotFound: missing, untouchable or no longer live. Conflict: already resolved. BadRequest: `keepId` outside the pair. */
export function resolveMemoryConflict(ctx: Context, conflictId: number, opts: ResolveMemoryConflictOpts): ResolveMemoryConflictResult {
  // Read with every status, so a resolved conflict answers 409 while one holding another person's personal row stays a 404.
  const conflict = listTouchableConflicts(ctx.hippoRoot, '*', ctx.tenantId, ctx.actor).find((c) => c.id === conflictId);
  if (!conflict) throw new NotFoundError(`conflict not found: ${conflictId}`);
  if (conflict.status !== 'open') throw new ConflictError(`conflict ${conflictId} is already resolved`);
  const pair = [conflict.memory_a_id, conflict.memory_b_id];
  if (!pair.includes(opts.keepId)) throw new BadRequestError(`keep must be one of the two memories in conflict ${conflictId}: ${pair.join(', ')}`);
  if (loadEntriesByIds(ctx.hippoRoot, pair, ctx.tenantId).filter(isLive).length < pair.length) {
    throw new NotFoundError(`conflict ${conflictId} names a memory that is superseded, archived or quarantined`);
  }
  const resolved = resolveConflict(ctx.hippoRoot, conflictId, opts.keepId, opts.forget === true, ctx.tenantId, {
    rejectLoserValue: opts.rejectLoser === true,
    reason: opts.reason,
    rejectedBy: ctx.actor.subject,
  });
  // Every check passed above, so null here is another resolver getting there first.
  if (resolved === null) throw new ConflictError(`conflict ${conflictId} is already resolved`);
  return { conflictId, keptId: opts.keepId, loserId: resolved.loserId };
}
