// Forget a memory, and reject or unreject a value so it cannot be stored again.

import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import { rejectValue, unrejectValue, type RejectFlowResult } from '../../domain/trust/reject-flow.js';
import { requireHostAdmin, type Context } from '../types.js';
import { memoryGet } from './memories.js';
import { canTouchScope, personalScopeOf } from '../../base/scope/recall-scope.js';

/** Delete a memory by id. Reach is checked inside the delete's write scope, and a row out of reach answers as not
 * found, so a caller learns nothing about it. */
export interface ForgetResult {
  ok: true;
  id: string;
}
export async function forget(ctx: Context, id: string): Promise<ForgetResult> {
  const entryWrites = ctx.store.entryWrites;
  await entryWrites.forget({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ownScope: personalScopeOf(ctx.actor),
    id,
  });
  return { ok: true, id };
}

// Reject administration is Context-based and tenant-checked; it shares one transaction flow with `hippo reject` via
// src/domain/trust/reject-flow.ts.

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

/** Tombstones a value's normalized digest so a matching write is refused everywhere until `unreject`; pass exactly one
 * of `memoryId` or `value`. `memoryId` also removes every live tenant row with that digest (not others' personal rows);
 * `reason` is required. Throws on an unknown id or both/neither. */
export async function reject(ctx: Context, opts: RejectOptions): Promise<RejectResult> {
  if (opts.memoryId !== undefined) {
    // Tenant scope: same not-found-shaped denial as forget/promote; rejectValue tenant-checks too, but pre-checking
    // keeps the error message consistent.
    const entry = await memoryGet(ctx, opts.memoryId);
    if (entry === null || !canTouchScope(ctx.actor, entry.scope)) {
      throw new NotFoundError(`memory not found: ${opts.memoryId}`);
    }
  }
  const result = await applyReject(ctx, opts);
  return { digest: result.digest, removedIds: result.removedIds };
}

/** `hippo reject` on the host: every row it removed and the rows that kept their other texts. A personal row by id
 * answers with the personal refusal rather than reject's not-found, as the operator can see that row. */
export async function rejectOnHost(ctx: Context, opts: RejectOptions): Promise<RejectFlowResult> {
  requireHostAdmin(ctx, 'Rejecting with the removal report');
  return applyReject(ctx, opts);
}

function applyReject(ctx: Context, opts: RejectOptions): Promise<RejectFlowResult> {
  return rejectValue(ctx.store, {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    reason: opts.reason,
    memoryId: opts.memoryId,
    value: opts.value,
    ownScope: personalScopeOf(ctx.actor) ?? undefined,
  });
}

/** Deletes a tombstone by exact digest or unambiguous prefix, restoring writability (the only v1 escape hatch); throws
 * on blank, no match or several. */
export async function unreject(ctx: Context, digestOrPrefix: string) {
  const outcome = await unrejectValue(ctx.store, ctx.tenantId, digestOrPrefix, ctx.actor.subject);
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
