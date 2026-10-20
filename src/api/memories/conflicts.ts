// Conflict listing and resolution for every front end, so the reach, status, pair and liveness rules live here.
import { BadRequestError, ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import {
  canTouchScope,
  isPersonalScope,
  passesScopeFilterForRecall,
  personalScopeOf,
} from '../../base/scope/recall-scope.js';
import type { MemoryConflict } from '../../store/port/conflicts.js';
import type { ConflictMember, ConflictRow, ConflictSide, LoserFate } from '../../store/port/conflicts.js';
import { classifyOriginProject } from '../../base/scope/project-identity.js';
import type { CallerProject } from '../prompt-hook.js';
import { isQuarantineScope } from '../../domain/trust/quarantine.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, resolveListLimit } from '../../base/util/limits.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { requireHostAdmin, type Actor, type Context } from '../types.js';
import type { TenantReach } from './memories.js';

/** A page of a conflict list: `limit` (default 100, at most 1000) and the position the previous page ended on. */
export interface ConflictPageOptions {
  limit?: number;
  after?: KeysetPosition;
}

export interface ConflictPage {
  conflicts: MemoryConflict[];
  /** Where the next page starts, or null after the last; a filtered page can be short and still go on. */
  next: KeysetPosition | null;
}

export interface ResolveMemoryConflictOptions {
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

function isLive(member: ConflictMember | null): boolean {
  return (
    member !== null &&
    !member.superseded_by &&
    (member.kind === 'raw' || member.kind === 'distilled') &&
    !isQuarantineScope(member.scope)
  );
}

/** Someone else's personal row hides its whole pair. */
function touchable(actor: Actor, row: ConflictRow): boolean {
  return [row.a, row.b].every((member) => member !== null && canTouchScope(actor, member.scope));
}

function pageLimit(limit: number | undefined): number {
  const resolved = resolveListLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  if (resolved === undefined) throw new BadRequestError(`limit must be a positive integer <= ${MAX_LIST_LIMIT}`);
  return resolved;
}

async function touchableConflict(ctx: Context, conflictId: number): Promise<ConflictRow | null> {
  const row = await ctx.store.conflicts.get(ctx.tenantId, conflictId);
  return row !== null && touchable(ctx.actor, row) ? row : null;
}

/** Conflict `conflictId` in the caller's tenant, any status; null when missing or a row of it is out of reach. */
export async function conflictGet(ctx: Context, conflictId: number): Promise<MemoryConflict | null> {
  return (await touchableConflict(ctx, conflictId))?.conflict ?? null;
}

/** Keeps `keepId` and weakens, deletes or rejects the other side, auditing as `ctx.actor`. NotFound: missing,
 * untouchable or no longer live. Conflict: already resolved. BadRequest: `keepId` outside the pair. */
export async function conflictResolve(
  ctx: Context,
  conflictId: number,
  opts: ResolveMemoryConflictOptions,
): Promise<ResolveMemoryConflictResult> {
  // Any status, so a resolved conflict answers 409 while one holding another person's personal row stays a 404.
  const row = await touchableConflict(ctx, conflictId);
  if (!row) throw new NotFoundError(`conflict not found: ${conflictId}`);
  if (row.conflict.status !== 'open') throw new ConflictError(`conflict ${conflictId} is already resolved`);
  const { keep, loser } = sidesOf(row, opts.keepId);
  if (!isLive(row.a) || !isLive(row.b)) {
    throw new NotFoundError(`conflict ${conflictId} names a memory that is superseded, archived or quarantined`);
  }
  const reason = opts.reason ?? `resolveConflict ${conflictId}: kept ${keep.id}`;
  const fate = loserFate(ctx.actor, loser, opts);
  const resolved = await ctx.store.conflicts.resolve(ctx.tenantId, {
    conflictId,
    keep,
    loser,
    fate,
    actor: ctx.actor.subject,
    reason,
  });
  // Every check passed above, so false here is another resolver, or a scope change, getting there first.
  if (!resolved) throw new ConflictError(`conflict ${conflictId} is already resolved`);
  return { conflictId, keptId: keep.id, loserId: loser.id };
}

interface ResolveSides {
  readonly keep: ConflictSide;
  readonly loser: ConflictSide;
}

/** `keepId`'s side and the other one, with the scopes the store must still find at write time. */
function sidesOf(row: ConflictRow, keepId: string): ResolveSides {
  const { conflict } = row;
  const a = { id: conflict.memory_a_id, scope: row.a?.scope ?? null };
  const b = { id: conflict.memory_b_id, scope: row.b?.scope ?? null };
  if (keepId === a.id) return { keep: a, loser: b };
  if (keepId === b.id) return { keep: b, loser: a };
  throw new BadRequestError(`keep must be one of the two memories in conflict ${conflict.id}: ${a.id}, ${b.id}`);
}

/** A rejection is a tenant-wide tombstone, so it may not carry a personal row's value, and its sweep stays within what
 * the caller may touch. */
function loserFate(actor: Actor, loser: ConflictSide, opts: ResolveMemoryConflictOptions): LoserFate {
  if (opts.rejectLoser !== true) return { kind: opts.forget === true ? 'remove' : 'weaken' };
  if (isPersonalScope(loser.scope)) {
    throw new BadRequestError(
      `cannot reject the value of personal memory ${loser.id}: a rejection reaches the whole tenant, ` +
        `so its reason would show to everyone; resolve with forget instead`,
    );
  }
  return { kind: 'reject', ownScope: personalScopeOf(actor) };
}

/** One page of open conflicts whose two rows the caller may touch; with `project`, only pairs it could also recall: its
 *  repo or user-global, and no scope it was not asked for. */
export async function conflictListOpen(
  ctx: Context,
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
      classifyOriginProject(member.origin_project, project) !== 'cross-project' &&
      passesScopeFilterForRecall(member.scope, undefined, own));
  const shown = (row: ConflictRow): boolean => touchable(ctx.actor, row) && recallable(row.a) && recallable(row.b);
  return { conflicts: page.rows.filter(shown).map((row) => row.conflict), next: page.next };
}

/** One page of conflicts with `status` ('*' for any) in reach, with no scope filter: the host's own view, so the host
 * admin only. */
export async function conflictList(
  ctx: Context,
  status: string,
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

/** Every conflict a paged list returns, read the largest page at a time, for the verbs that print the whole list. */
export async function conflictListAll(
  read: (page: ConflictPageOptions) => Promise<ConflictPage>,
): Promise<MemoryConflict[]> {
  const all: MemoryConflict[] = [];
  let after: KeysetPosition | undefined;
  do {
    const page = await read({ limit: MAX_LIST_LIMIT, after });
    all.push(...page.conflicts);
    after = page.next ?? undefined;
  } while (after);
  return all;
}
