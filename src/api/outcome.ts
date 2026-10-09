// Outcome feedback on recalled memories.

import { personalScopeOf } from '../recall-scope.js';
import { andThen, notPorted, onStore } from './on-store.js';
import type { Context, StoreReply } from './types.js';

/** An id outside ctx.tenantId, or in someone else's personal scope, is skipped, so a stale id never fails the call.
 *  `appliedIds` holds only the ids applied: a caller that answers across tenants returns it, never the ids it was sent. */
export interface OutcomeResult {
  applied: number;
  appliedIds: string[];
}
/** `opts.traceId` links the outcome to the recall trace it judges. Only outcomeForLastRecall sends one: explicit ids may follow no recall at all. */
export function outcome<C extends Context>(
  ctx: C,
  ids: ReadonlyArray<string>,
  good: boolean,
  opts?: { traceId?: number },
): StoreReply<C, OutcomeResult> {
  return onStore(ctx, (port, local) => {
    const entryWrites = port.entryWrites ?? notPorted(port, 'entryWrites');
    const write = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), ids, good };
    const traceId = opts?.traceId;
    // The trace link is written on hippo.db's own handle after the commit, so a served store refuses a traceId.
    const applied = traceId === undefined ? entryWrites.applyOutcome(write) : local.applyOutcome(write, traceId);
    return andThen(applied, (appliedIds): OutcomeResult => ({ applied: appliedIds.length, appliedIds }));
  });
}

/** The last recall's ids and its trace sit in hippo.db's meta table, which only the CLI and context write, so a store of another kind is refused.
 *  `ids` holds only the ids applied in ctx.tenantId: the index is not tenant-scoped, so the ids read from it are never returned. */
export interface OutcomeForLastRecallResult {
  applied: number;
  ids: string[];
}
export function outcomeForLastRecall<C extends Context>(
  ctx: C,
  good: boolean,
): StoreReply<C, OutcomeForLastRecallResult> {
  return onStore(ctx, (_port, local) => {
    const ids = local.applyOutcomeToLastRecall({ tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor) }, good);
    return { applied: ids.length, ids };
  });
}
