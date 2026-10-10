// Forget a memory, and reject or unreject a value so it cannot be stored again.

import { BadRequestError, NotFoundError } from '../core/api-errors.js';
import { rejectValue, unrejectValue } from '../trust/reject-flow.js';
import { andThen, notPorted, onStore } from './on-store.js';
import type { Context, StoreReply } from './types.js';
import { readEntry } from '../store/entry-reads.js';
import { canTouchScope, personalScopeOf } from '../store/recall-scope.js';

/** Delete a memory by id. Reach is checked inside the delete's write scope, and a
 * row out of reach answers as not found, so a caller learns nothing about it. */
export interface ForgetResult {
  ok: true;
  id: string;
}
export function forget<C extends Context>(ctx: C, id: string): StoreReply<C, ForgetResult> {
  return onStore(ctx, (port) => {
    const entryWrites = port.entryWrites ?? notPorted(port, 'entryWrites');
    const removal = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), id };
    return andThen(entryWrites.forget(removal), (): ForgetResult => ({ ok: true, id }));
  });
}

// Reject administration is Context-based and tenant-checked; it shares one transaction flow with `hippo reject` via src/trust/reject-flow.ts.

export interface RejectOpts {
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

/** Tombstones a value's normalized digest so a matching write is refused everywhere until `unreject`; pass exactly one of `memoryId` or `value`.
 * `memoryId` also removes every live tenant row with that digest (not others' personal rows); `reason` is required. Throws on an unknown id or both/neither. */
export function reject(ctx: Context, opts: RejectOpts): RejectResult {
  if (opts.memoryId !== undefined) {
    // Tenant scope: same not-found-shaped denial as forget/promote; rejectValue tenant-checks too, but pre-checking keeps the error message consistent.
    const entry = readEntry(ctx.hippoRoot, opts.memoryId);
    if (entry?.tenantId !== ctx.tenantId || !canTouchScope(ctx.actor, entry.scope)) {
      throw new NotFoundError(`memory not found: ${opts.memoryId}`);
    }
  }
  const result = rejectValue({
    hippoRoot: ctx.hippoRoot,
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    reason: opts.reason,
    memoryId: opts.memoryId,
    value: opts.value,
    ownScope: personalScopeOf(ctx.actor) ?? undefined,
  });
  return { digest: result.digest, removedIds: result.removedIds };
}

/** Deletes a tombstone by exact digest or unambiguous prefix, restoring writability (the only v1 escape hatch); throws on blank, no match or several. */
export function unreject(ctx: Context, digestOrPrefix: string) {
  const outcome = unrejectValue(ctx.hippoRoot, ctx.tenantId, digestOrPrefix, ctx.actor.subject);
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
