// The reject, unreject and list flow the CLI verbs and the api functions share: the rules and their wording live here,
// and the store's rejections group runs each one in one write.

import { BadRequestError } from '../core/api-errors.js';
import { isPersonalScope } from '../core/recall-scope.js';
import { mergedSuccessor } from '../core/merged-row.js';
import type { HippoStore } from '../store/index.js';
import { normalizeValueForRejection, type RejectedValueRow } from '../store/rejection.js';
import type { AppliedRejection, LiftedRejection, RejectionSource } from '../store/rejected-values.js';

export interface RejectFlowOptions {
  tenantId: string;
  actor: string;
  reason: string;
  /** By-id form: reject the CURRENT content of an existing memory. */
  memoryId?: string;
  /** Pre-emptive form: reject a value not currently stored (or already gone). */
  value?: string;
  /**
   * The caller's own personal scope: the only personal rows the sweep may remove. Unset (the CLI) skips every personal
   * row.
   */
  ownScope?: string;
}

export type RejectFlowResult = AppliedRejection;

function assertRejectOpts(opts: RejectFlowOptions): void {
  if (!opts.reason.trim()) {
    throw new Error(
      'reject requires a non-empty --reason (the tombstone stores no content; reason is its only identity).',
    );
  }
  if (opts.memoryId === undefined && opts.value === undefined) {
    throw new Error('reject requires either a memory id or --value.');
  }
  if (opts.memoryId !== undefined && opts.value !== undefined) {
    // Enforced here, not only in the CLI parser, so a direct api caller passing both
    // is refused instead of silently getting the memoryId path with `value` ignored.
    throw new Error('reject accepts either a memory id or --value, not both.');
  }
  if (opts.value !== undefined && normalizeValueForRejection(opts.value).length === 0) {
    // Direct api callers can pass strings the CLI flag parser would refuse; an empty-normalized tombstone would refuse
    // nothing and pollute the listing.
    throw new Error('reject --value requires non-empty content.');
  }
}

function contentToReject(opts: RejectFlowOptions, row: RejectionSource | undefined): string {
  if (opts.memoryId === undefined) return opts.value!;
  if (!row || row.tenant_id !== opts.tenantId) {
    throw new Error(`memory not found: ${opts.memoryId}`);
  }
  // A tombstone is tenant-wide, so one made from personal text would show its reason to everyone.
  if (isPersonalScope(row.scope)) {
    throw new BadRequestError("Personal memories can't be rejected. Use forget to remove it.");
  }
  return row.content;
}

/** Every row but another person's personal one, which is outside the caller's recall and so outside its reject. */
function inReach(opts: RejectFlowOptions, scope: string | null | undefined): boolean {
  return !isPersonalScope(scope) || scope === opts.ownScope;
}

/**
 * `hippo reject` and `api.reject`: refuses a bad request, then tombstones the value and removes every row in reach that
 * holds it.
 */
export async function rejectValue(store: HippoStore, opts: RejectFlowOptions): Promise<RejectFlowResult> {
  assertRejectOpts(opts);
  return store.rejections.apply({
    tenantId: opts.tenantId,
    actor: opts.actor,
    reason: opts.reason,
    memoryId: opts.memoryId,
    textOf: (source) => contentToReject(opts, source),
    inReach: (scope) => inReach(opts, scope),
    successorOf: mergedSuccessor,
  });
}

export type UnrejectOutcome = LiftedRejection;

/**
 * `hippo unreject` and `api.unreject`: lifts the one tombstone a digest or prefix names. The only way to allow a
 * rejected value again.
 */
export async function unrejectValue(
  store: HippoStore,
  tenantId: string,
  digestOrPrefix: string,
  actor: string,
): Promise<UnrejectOutcome> {
  // A blank prefix would match every digest and list the whole tombstone set as ambiguous.
  if (digestOrPrefix.trim().length === 0) {
    return { status: 'not_found' };
  }
  return store.rejections.lift(tenantId, digestOrPrefix, actor);
}

/** `hippo rejections` / `api.listRejections` — list tombstones for a tenant. */
export function listRejectionsForTenant(store: HippoStore, tenantId: string): Promise<RejectedValueRow[]> {
  return store.rejections.list(tenantId);
}
