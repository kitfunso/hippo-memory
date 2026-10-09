// Forget a memory, and reject or unreject a value so it cannot be stored again.

import { BadRequestError, NotFoundError } from '../core/api-errors.js';
import type { RejectedValueRow } from '../store/rejection.js';
import { rejectValue, unrejectValue, listRejectionsForTenant } from '../trust/reject-flow.js';
import { andThen, notPorted, onStore } from './on-store.js';
import type { Context, StoreReply } from './types.js';
import { readEntry } from '../store/entry-reads.js';
import { canTouchScope, personalScopeOf } from '../store/recall-scope.js';

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/** Delete a memory by id. Reach is checked inside the delete's write scope, and a row out of reach answers as not found, so a caller learns nothing about it. */
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

// ---------------------------------------------------------------------------
// reject / unreject / listRejections
//
// Context-based, tenant-checked, so HTTP/MCP reject-administration endpoints
// can be added later without touching store internals (the write-path guard
// itself already protects every write surface today — only this admin
// surface is CLI/api-first, plan §4 non-goals). Shares the exact same
// transaction flow as `hippo reject`/`rejections`/`unreject` via
// src/trust/reject-flow.ts — neither surface duplicates it.
// ---------------------------------------------------------------------------

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

/**
 * Reject a value: tombstone its normalized digest so a matching write is
 * refused everywhere (remember/capture/import/sync) until `unreject`. Two
 * forms — pass exactly one:
 *  - `memoryId`: reject the CURRENT content of an existing memory. Removes
 *    that row and every other live row in the tenant whose normalized
 *    digest matches (not just the id passed), except another person's personal rows.
 *  - `value`: pre-emptive form — tombstone content that may not currently
 *    be stored (or is already gone). Zero removals.
 *
 * `reason` is required (the tombstone stores no content; reason is its
 * only human-readable identity). Throws if the memory id is not found in
 * `ctx.tenantId`, or if both/neither of `memoryId`/`value` are given.
 */
export function reject(ctx: Context, opts: RejectOpts): RejectResult {
  if (opts.memoryId !== undefined) {
    // Tenant scope, same not-found-shaped denial as forget/promote above:
    // rejectValue itself also tenant-checks the id, but pre-checking here
    // keeps the error message consistent with the rest of this module.
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

/**
 * Delete a tombstone by exact digest or unambiguous prefix, restoring the
 * value's writability — the only v1 escape hatch (no per-write force flag).
 * Throws if `digestOrPrefix` matches no tombstone, is blank, or matches
 * more than one (use a longer prefix).
 */
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

/** List every rejected-value tombstone for `ctx.tenantId`, newest first. */
export function listRejections(ctx: Context): RejectedValueRow[] {
  return listRejectionsForTenant(ctx.hippoRoot, ctx.tenantId);
}
