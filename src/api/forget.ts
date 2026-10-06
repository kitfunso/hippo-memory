// Forget a memory, and reject or unreject a value so it cannot be stored again.

import { openHippoDb, closeHippoDb } from '../db.js';
import { BadRequestError, NotFoundError } from '../api-errors.js';
import { deleteEntry } from '../store/delete-and-batch.js';
import { updateStatsUnlessBusy } from '../store/index-and-stats.js';
import type { RejectedValueRow } from '../rejection.js';
import { rejectValue, unrejectValue, listRejectionsForTenant } from '../reject-flow.js';
import type { Context } from './types.js';
import { selectMemoryReach } from '../store/tenant-lookup.js';
import { canTouchScope } from '../recall-scope.js';

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/**
 * Delete a memory by id. `deleteEntry` threads ctx.actor.subject into its internal
 * audit hook, so exactly one 'forget' event lands with the supplied actor.
 *
 * Tenant scope: deleteEntry looks up the row by id alone, so without an
 * explicit tenant guard a Bearer for tenant A could delete tenant B's row
 * by guessing or leaking the id. Pre-check the row's tenant_id and deny
 * cross-tenant access with a not-found error (no info leak about whether
 * the id exists in another tenant).
 */
export interface ForgetResult {
  ok: true;
  id: string;
}
export function forget(ctx: Context, id: string): ForgetResult {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const reach = selectMemoryReach(db, id);
    if (reach?.tenantId !== ctx.tenantId || !canTouchScope(ctx.actor, reach.scope)) {
      throw new NotFoundError(`memory not found: ${id}`);
    }
  } finally {
    closeHippoDb(db);
  }
  const removed = deleteEntry(ctx.hippoRoot, id, { actor: ctx.actor.subject });
  if (!removed) {
    throw new NotFoundError(`memory not found: ${id}`);
  }
  // Counted here, not in the CLI: both callers of this function (cmdForget and
  // the HTTP route) are the two paths of one user command, so neither can miss
  // it. api.remember cannot take the same move; see the server route.
  updateStatsUnlessBusy(ctx.hippoRoot, { forgotten: 1 }, `removed ${id}`);
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// reject / unreject / listRejections
//
// Context-based, tenant-checked, so HTTP/MCP reject-administration endpoints
// can be added later without touching store internals (the write-path guard
// itself already protects every write surface today — only this admin
// surface is CLI/api-first, plan §4 non-goals). Shares the exact same
// transaction flow as `hippo reject`/`rejections`/`unreject` via
// src/reject-flow.ts — neither surface duplicates it.
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
 *    digest matches (not just the id passed).
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
    const db = openHippoDb(ctx.hippoRoot);
    try {
      const reach = selectMemoryReach(db, opts.memoryId);
      if (reach?.tenantId !== ctx.tenantId || !canTouchScope(ctx.actor, reach.scope)) {
        throw new NotFoundError(`memory not found: ${opts.memoryId}`);
      }
    } finally {
      closeHippoDb(db);
    }
  }
  const result = rejectValue({
    hippoRoot: ctx.hippoRoot,
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    reason: opts.reason,
    memoryId: opts.memoryId,
    value: opts.value,
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
