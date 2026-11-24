import { BadRequestError, ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import {
  assertWriteRight,
  canReadScope,
  passesScopeFilterForRecall,
  personalScopeOf,
  scopeReaderOf,
} from '../../base/scope/recall-scope.js';
import type { MemoryConflict } from '../../base/ports/store/conflicts.js';
import type {
  ConflictMember,
  ConflictRow,
  ConflictSide,
  ConflictStatus,
} from '../../base/ports/store/conflicts.js';
import { conflictLoserFate } from '../../domain/consolidate/conflicts.js';
import { classifyOriginProject } from '../../base/scope/project-identity.js';
import type { CallerProject } from '../prompt-hook.js';
import { isLiveMemory } from '../../base/scope/live-memory.js';
import { MAX_LIST_LIMIT } from '../../base/util/limits.js';
import { keysetPages, pageLimit } from '../pages.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { requireHostAdmin, type Actor, type ContextWith } from '../types.js';
import type { TenantReach } from './memories.js';

/** A page of a conflict list: `limit` (default DEFAULT_LIST_LIMIT, at most MAX_LIST_LIMIT) and
 * the position the previous page ended on. */
export interface ConflictPageOptions {
  limit?: number;
  after?: KeysetPosition;
}

export interface ConflictPage {
  conflicts: MemoryConflict[];
  next: KeysetPosition | null;
}

export interface ResolveMemoryConflictOptions {
  keepId: string;
  forget?: boolean;
  rejectLoser?: boolean;
  reason?: string;
}

export interface ResolveMemoryConflictResult {
  conflictId: number;
  keptId: string;
  loserId: string;
}

function touchable(actor: Actor, row: ConflictRow): boolean {
  return [row.a, row.b].every((member) => member !== null && canReadScope(actor, member.scope));
}

async function touchableConflict(
  ctx: ContextWith<'conflicts'>,
  conflictId: number,
): Promise<ConflictRow | null> {
  const row = await ctx.store.conflicts.get(ctx.tenantId, conflictId);
  return row !== null && touchable(ctx.actor, row) ? row : null;
}

/** Conflict `conflictId` in the caller's tenant, any status; null when missing or a row of it is
 * out of reach. */
export async function conflictGet(
  ctx: ContextWith<'conflicts'>,
  conflictId: number,
): Promise<MemoryConflict | null> {
  return (await touchableConflict(ctx, conflictId))?.conflict ?? null;
}

/** Keeps `keepId` and weakens, deletes or rejects the other side, auditing as `ctx.actor`.
 * NotFound: missing, untouchable or no longer live. Forbidden: a loser to remove the caller may
 * not change. Conflict: already resolved. BadRequest: `keepId` outside the pair. */
export async function conflictResolve(
  ctx: ContextWith<'conflicts'>,
  conflictId: number,
  opts: ResolveMemoryConflictOptions,
): Promise<ResolveMemoryConflictResult> {
  const row = await touchableConflict(ctx, conflictId);
  if (!row) throw new NotFoundError(`conflict not found: ${conflictId}`);
  if (row.conflict.status !== 'open') {
    throw new ConflictError(`conflict ${conflictId} is already resolved`);
  }
  const { keep, loser } = sidesOf(row, opts.keepId);
  const { a, b } = row;
  if (!(a !== null && isLiveMemory(a) && b !== null && isLiveMemory(b))) {
    throw new NotFoundError(
      `conflict ${conflictId} names a memory that is superseded, archived or quarantined`,
    );
  }
  const reason = opts.reason ?? `resolveConflict ${conflictId}: kept ${keep.id}`;
  const fate = conflictLoserFate(opts, loser, personalScopeOf(ctx.actor));
  if (fate.kind !== 'weaken') await assertMayRemove(ctx, conflictId, loser.id);
  const resolved = await ctx.store.conflicts.resolve(ctx.tenantId, {
    conflictId,
    keep,
    loser,
    fate,
    actor: ctx.actor.subject,
    reason,
    at: ctx.infra.clock().toISOString(),
  });
  if (!resolved) throw new ConflictError(`conflict ${conflictId} is already resolved`);
  return { conflictId, keptId: keep.id, loserId: loser.id };
}

async function assertMayRemove(
  ctx: ContextWith<'conflicts'>,
  conflictId: number,
  loserId: string,
): Promise<void> {
  const [loser] = await ctx.store.entriesByIds([loserId], ctx.tenantId);
  assertWriteRight(scopeReaderOf(ctx.actor), loser, loserId, `conflict not found: ${conflictId}`);
}

interface ResolveSides {
  readonly keep: ConflictSide;
  readonly loser: ConflictSide;
}

function sidesOf(row: ConflictRow, keepId: string): ResolveSides {
  const { conflict } = row;
  const a = { id: conflict.memoryAId, scope: row.a?.scope ?? null };
  const b = { id: conflict.memoryBId, scope: row.b?.scope ?? null };
  if (keepId === a.id) return { keep: a, loser: b };
  if (keepId === b.id) return { keep: b, loser: a };
  throw new BadRequestError(
    `keep must be one of the two memories in conflict ${conflict.id}: ${a.id}, ${b.id}`,
  );
}

/** One page of open conflicts whose two rows the caller may touch; with `project`, only pairs it could also recall: its
 *  repo or user-global, and no scope it was not asked for. */
export async function conflictListOpen(
  ctx: ContextWith<'conflicts'>,
  opts: ConflictPageOptions & { project?: CallerProject } = {},
): Promise<ConflictPage> {
  const { project } = opts;
  const page = await ctx.store.conflicts.list({
    tenantId: ctx.tenantId,
    status: 'open',
    limit: pageLimit(opts.limit),
    after: opts.after,
  });
  const own = personalScopeOf(ctx.actor);
  const recallable = (member: ConflictMember | null): boolean =>
    !project ||
    (member !== null &&
      classifyOriginProject(member.originProject, project) !== 'cross-project' &&
      passesScopeFilterForRecall(member.scope, undefined, own));
  const shown = (row: ConflictRow): boolean =>
    touchable(ctx.actor, row) && recallable(row.a) && recallable(row.b);
  return { conflicts: page.rows.filter(shown).map((row) => row.conflict), next: page.next };
}

/** One page of conflicts with `status` ('*' for any) in reach, with no scope filter: the host's
 * own view, so the host admin only. */
export async function conflictList(
  ctx: ContextWith<'conflicts'>,
  status: ConflictStatus | '*',
  reach: TenantReach = {},
  opts: ConflictPageOptions = {},
): Promise<ConflictPage> {
  requireHostAdmin(ctx, 'Listing conflicts past the scope check');
  const page = await ctx.store.conflicts.list({
    tenantId: reach.everyTenant ? ALL_TENANTS : ctx.tenantId,
    status,
    limit: pageLimit(opts.limit),
    after: opts.after,
  });
  return { conflicts: page.rows.map((row) => row.conflict), next: page.next };
}

/** Each page a paged list answers from `start`, the largest page at a time, for the verbs that
 * print every conflict. */
export function conflictPages(
  read: (page: ConflictPageOptions) => Promise<ConflictPage>,
  start?: KeysetPosition,
): AsyncGenerator<ConflictPage> {
  return keysetPages((after) => read({ limit: MAX_LIST_LIMIT, after }), start);
}
