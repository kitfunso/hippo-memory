// Reject or unreject a value so it cannot be stored again, on hippo.db's local tier.

import {
  BadRequestError,
  memoryNotFoundText,
  NotFoundError,
} from '../../base/errors/api-errors.js';
import {
  listRejectionsForTenant,
  rejectValue,
  unrejectValue,
  type RejectFlowResult,
  type UnrejectOutcome,
} from '../../domain/trust/reject-flow.js';
import type { RejectedValueRow } from '../../base/records/rejections.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { requireHostAdmin } from '../types.js';
import { memoryGet } from '../memories/memories.js';
import { canReadScope, personalScopeOf } from '../../base/scope/recall-scope.js';
import type { HippoDbContext } from '../hippo-db-context.js';

// Reject administration is Context-based and tenant-checked; it shares one transaction flow with
// `hippo reject` via src/domain/trust/reject-flow.ts.

export interface RejectOptions {
  /** By-id form: reject the CURRENT content of an existing memory. */
  memoryId?: string;
  /** Pre-emptive form: reject a value not currently stored (or already gone). */
  value?: string;
  /** Required — the tombstone stores no content; reason is its only identity. */
  reason: string;
}

export interface RejectResult {
  digest: string;
  removedIds: string[];
}

/** Tombstones a value's normalized digest so a matching write is refused everywhere until
 * `unreject`; pass exactly one of `memoryId` or `value`. `memoryId` also removes every live
 * tenant row with that digest (not others' personal rows); `reason` is required. Throws on an
 * unknown id or both/neither. */
export async function reject(ctx: HippoDbContext, opts: RejectOptions): Promise<RejectResult> {
  if (opts.memoryId !== undefined) {
    // Tenant scope: same not-found-shaped denial as forget/promote; rejectValue tenant-checks too,
    // but pre-checking keeps the error message consistent.
    const entry = await memoryGet(ctx, opts.memoryId);
    if (entry === null || !canReadScope(ctx.actor, entry.scope)) {
      throw new NotFoundError(memoryNotFoundText(opts.memoryId));
    }
  }
  const result = await applyReject(ctx, opts);
  return { digest: result.digest, removedIds: result.removedIds };
}

/** `hippo reject` on the host: every row it removed and the rows that kept their other texts. A
 * personal row by id answers with the personal refusal rather than reject's not-found, as the
 * operator can see that row. */
export async function rejectOnHost(
  ctx: HippoDbContext,
  opts: RejectOptions,
): Promise<RejectFlowResult> {
  requireHostAdmin(ctx, 'Rejecting with the removal report');
  return applyReject(ctx, opts);
}

function applyReject(ctx: HippoDbContext, opts: RejectOptions): Promise<RejectFlowResult> {
  return rejectValue(ctx.store, {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    reason: opts.reason,
    memoryId: opts.memoryId,
    value: opts.value,
    ownScope: personalScopeOf(ctx.actor) ?? undefined,
  });
}

/** Lifts the tombstone a digest or unambiguous prefix names, as the caller; a blank one, no
 * match or several come back as the outcome, so a caller can list the candidates. */
export function liftRejection(
  ctx: HippoDbContext,
  digestOrPrefix: string,
): Promise<UnrejectOutcome> {
  return unrejectValue(ctx.store, {
    tenantId: ctx.tenantId,
    digestOrPrefix,
    actor: ctx.actor.subject,
  });
}

/** Writes nothing, so a dry run counts what a real run refuses. */
export async function wouldRefuse(
  ctx: HippoDbContext,
  entry: Pick<MemoryEntry, 'id' | 'content'>,
): Promise<boolean> {
  const check = { tenantId: ctx.tenantId, entryId: entry.id, content: entry.content };
  const [refused] = await ctx.store.hippoDb.rejections.refusedAmong([check]);
  return refused === true;
}

/** Every tombstone of the caller's tenant. */
export function listRejections(ctx: HippoDbContext): Promise<RejectedValueRow[]> {
  return listRejectionsForTenant(ctx.store, ctx.tenantId);
}

/** Deletes a tombstone by exact digest or unambiguous prefix, restoring writability (the only v1
 * escape hatch); throws on blank, no match or several. */
export async function unreject(ctx: HippoDbContext, digestOrPrefix: string) {
  const outcome = await liftRejection(ctx, digestOrPrefix);
  if (outcome.status === 'not_found') {
    throw new NotFoundError(`no rejected value matches: ${digestOrPrefix}`);
  }
  if (outcome.status === 'ambiguous') {
    throw new BadRequestError(
      `"${digestOrPrefix}" matches ${outcome.candidates.length} tombstones; use a longer prefix`,
    );
  }
  return { ok: true, digest: outcome.digest };
}
