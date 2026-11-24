import type { StoreWith } from '../../base/ports/store.js';
import { normalizeValueForRejection } from '../../base/records/rejection-digest.js';
import type { AppliedRejection, LiftedRejection } from '../../base/ports/store/rejections.js';
import type { RejectedValueRow } from '../../base/ports/store/rejections.js';

export interface RejectFlowOptions {
  tenantId: string;
  actor: string;
  reason: string;
  memoryId?: string;
  value?: string;
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
    throw new Error('reject accepts either a memory id or --value, not both.');
  }
  if (opts.value !== undefined && normalizeValueForRejection(opts.value).length === 0) {
    throw new Error('reject --value requires non-empty content.');
  }
}

/**
 * `hippo reject` and `api.reject`: refuses a bad request, then tombstones the value and removes
 * every row in reach that holds it.
 */
export async function rejectValue(
  store: StoreWith<'rejections'>,
  opts: RejectFlowOptions,
): Promise<RejectFlowResult> {
  assertRejectOpts(opts);
  return store.rejections.apply({
    tenantId: opts.tenantId,
    actor: opts.actor,
    reason: opts.reason,
    memoryId: opts.memoryId,
    value: opts.value,
    ownScope: opts.ownScope ?? null,
  });
}

export type UnrejectOutcome = LiftedRejection;

export interface UnrejectOptions {
  readonly tenantId: string;
  readonly digestOrPrefix: string;
  readonly actor: string;
}

/**
 * `hippo unreject` and `api.unreject`: lifts the one tombstone a digest or prefix names. The only
 * way to allow a rejected value again.
 */
export async function unrejectValue(
  store: StoreWith<'rejections'>,
  { tenantId, digestOrPrefix, actor }: UnrejectOptions,
): Promise<UnrejectOutcome> {
  if (digestOrPrefix.trim().length === 0) {
    return { status: 'not_found' };
  }
  return store.rejections.lift(tenantId, digestOrPrefix, actor);
}

/** `hippo rejections` / `api.listRejections` — list tombstones for a tenant. */
export function listRejectionsForTenant(
  store: StoreWith<'rejections'>,
  tenantId: string,
): Promise<RejectedValueRow[]> {
  return store.rejections.list(tenantId);
}
