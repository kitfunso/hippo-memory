// Conflict resolution for every front end, so the reach, status, pair and liveness checks live in one place.
import { BadRequestError, ConflictError, NotFoundError } from '../../core/api-errors.js';
import type { MemoryEntry } from '../../core/memory.js';
import { chunked } from '../../util/chunked.js';
import { passesScopeFilterForRecall, personalScopeOf } from '../../core/recall-scope.js';
import type { MemoryConflict } from '../../store/rows.js';
import { classifyOriginProject } from '../../core/project-identity.js';
import type { CallerProject } from '../prompt-hook.js';
import { isQuarantineScope } from '../../trust/quarantine.js';
import { requireHostAdmin, type ContextWith } from '../types.js';
import type { TenantReach } from './memories.js';

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
  return (
    !entry.superseded_by && (entry.kind === 'raw' || entry.kind === 'distilled') && !isQuarantineScope(entry.scope)
  );
}

/**
 * Keeps `keepId` and weakens, deletes or rejects the other side of an open conflict in the caller's tenant, auditing as
 * `ctx.actor`.
 * NotFound: missing, untouchable or no longer live. Conflict: already resolved. BadRequest: `keepId` outside the pair.
 */
export async function resolveMemoryConflict(
  ctx: ContextWith<'conflicts'>,
  conflictId: number,
  opts: ResolveMemoryConflictOpts,
): Promise<ResolveMemoryConflictResult> {
  // Read with every status, so a resolved conflict answers 409 while one holding another person's personal row stays a
  // 404.
  const touchable = await ctx.store.conflicts.listTouchable(ctx.tenantId, '*', ctx.actor);
  const conflict = touchable.find((c) => c.id === conflictId);
  if (!conflict) throw new NotFoundError(`conflict not found: ${conflictId}`);
  if (conflict.status !== 'open') throw new ConflictError(`conflict ${conflictId} is already resolved`);
  const pair = [conflict.memory_a_id, conflict.memory_b_id];
  if (!pair.includes(opts.keepId)) {
    throw new BadRequestError(`keep must be one of the two memories in conflict ${conflictId}: ${pair.join(', ')}`);
  }
  if ((await ctx.store.entriesByIds(pair, ctx.tenantId)).filter(isLive).length < pair.length) {
    throw new NotFoundError(`conflict ${conflictId} names a memory that is superseded, archived or quarantined`);
  }
  const resolved = await ctx.store.conflicts.resolve(
    ctx.tenantId,
    { conflictId, keepId: opts.keepId, forgetLoser: opts.forget === true },
    {
      rejectLoserValue: opts.rejectLoser === true,
      reason: opts.reason,
      rejectedBy: ctx.actor.subject,
    },
  );
  // Every check passed above, so null here is another resolver getting there first.
  if (resolved === null) throw new ConflictError(`conflict ${conflictId} is already resolved`);
  return { conflictId, keptId: opts.keepId, loserId: resolved.loserId };
}

/** Open conflicts whose two rows the caller may touch; with `project`, only pairs it could also recall:
 *  its repo or user-global, and no scope it was not asked for. */
export async function listOpenConflicts(
  ctx: ContextWith<'conflicts'>,
  project?: CallerProject,
): Promise<MemoryConflict[]> {
  const touchable = await ctx.store.conflicts.listTouchable(ctx.tenantId, 'open', ctx.actor);
  if (!project) return touchable;
  const own = personalScopeOf(ctx.actor);
  const ids = [...new Set(touchable.flatMap((c) => [c.memory_a_id, c.memory_b_id]))];
  // entriesByIds reads at most one chunk of ids per call.
  const chunks = await Promise.all(chunked(ids).map((chunk) => ctx.store.entriesByIds(chunk, ctx.tenantId)));
  const rows = new Map(chunks.flat().map((row) => [row.id, row]));
  const shown = (id: string): boolean => {
    const row = rows.get(id);
    return row !== undefined && classifyOriginProject(row.origin_project, project) !== 'cross-project'
      && passesScopeFilterForRecall(row.scope ?? null, undefined, own);
  };
  return touchable.filter((c) => shown(c.memory_a_id) && shown(c.memory_b_id));
}

/**
 * Conflicts with `status` ('*' for any) in reach, with no scope filter: the host's own view, so the host admin only.
 */
export async function listConflicts(
  ctx: ContextWith<'conflicts'>,
  status: string,
  reach: TenantReach = {},
): Promise<MemoryConflict[]> {
  requireHostAdmin(ctx, 'Listing conflicts past the scope check');
  return ctx.store.conflicts.list(reach.everyTenant ? null : ctx.tenantId, status);
}
