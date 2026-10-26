// Forget a memory, and reject or unreject a value so it cannot be stored again.

import {
  BadRequestError,
  memoryNotFoundText,
  NotFoundError,
} from '../../base/errors/api-errors.js';
import { rawRemovalRefusal } from '../../base/errors/raw-append-only.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import {
  listRejectionsForTenant,
  rejectValue,
  unrejectValue,
  type RejectFlowResult,
  type UnrejectOutcome,
} from '../../domain/trust/reject-flow.js';
import type { RejectedValueRow } from '../../base/ports/store/rejections.js';
import { requireHostAdmin, type Context, type ContextWith } from '../types.js';
import { memoryGet } from './memories.js';
import { canReadScope, personalScopeOf, scopeReaderOf } from '../../base/scope/recall-scope.js';

/** Delete a memory by id. Write rights are checked inside the delete's write scope: a row out of
 * reach answers as not found, and a reached row the caller may not change answers 403. */
export interface ForgetResult {
  ok: true;
  id: string;
}
export async function forget(ctx: Context, id: string): Promise<ForgetResult> {
  const entryWrites = ctx.store.entryWrites;
  await entryWrites.forget({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    id,
  });
  return { ok: true, id };
}

/** The row `forget`, or with `archive` `rawArchive`, would remove now; throws the refusal that
 * call would throw. Reads only. */
export async function removalTarget(
  ctx: Context,
  id: string,
  archive: boolean,
): Promise<MemoryEntry> {
  const entry = await memoryGet(ctx, id);
  if (entry === null) throw new NotFoundError(memoryNotFoundText(id));
  const refusal = rawRemovalRefusal(entry, archive);
  if (refusal !== null) throw refusal;
  return entry;
}

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
export async function reject(
  ctx: ContextWith<'rejections'>,
  opts: RejectOptions,
): Promise<RejectResult> {
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
  ctx: ContextWith<'rejections'>,
  opts: RejectOptions,
): Promise<RejectFlowResult> {
  requireHostAdmin(ctx, 'Rejecting with the removal report');
  return applyReject(ctx, opts);
}

function applyReject(
  ctx: ContextWith<'rejections'>,
  opts: RejectOptions,
): Promise<RejectFlowResult> {
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
  ctx: ContextWith<'rejections'>,
  digestOrPrefix: string,
): Promise<UnrejectOutcome> {
  return unrejectValue(ctx.store, {
    tenantId: ctx.tenantId,
    digestOrPrefix,
    actor: ctx.actor.subject,
  });
}

/** Every tombstone of the caller's tenant. */
export function listRejections(ctx: ContextWith<'rejections'>): Promise<RejectedValueRow[]> {
  return listRejectionsForTenant(ctx.store, ctx.tenantId);
}

/** Deletes a tombstone by exact digest or unambiguous prefix, restoring writability (the only v1
 * escape hatch); throws on blank, no match or several. */
export async function unreject(ctx: ContextWith<'rejections'>, digestOrPrefix: string) {
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
