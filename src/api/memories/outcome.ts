// Outcome feedback on recalled memories.

import { personalScopeOf } from '../../core/recall-scope.js';
import { HttpError } from '../../util/http-util.js';
import { narrowStore } from '../../store/index.js';
import type { ContextWith, StoreContext } from '../types.js';

/** An id outside ctx.tenantId, or in someone else's personal scope, is skipped,
 *  so a stale id never fails the call. `appliedIds` holds only the ids applied:
 *  a caller that answers across tenants returns it, never the ids it was sent. */
export interface OutcomeResult {
  applied: number;
  appliedIds: string[];
}
/** `opts.traceId` links the outcome to the recall trace it judges. Only outcomeForLastRecall sends one: explicit ids
 * may follow no recall at all. */
export async function outcome(
  ctx: ContextWith<'entryWrites'>,
  ids: ReadonlyArray<string>,
  good: boolean,
  opts?: { traceId?: number },
): Promise<OutcomeResult> {
  const store = ctx.store;
  const entryWrites = store.entryWrites;
  const write = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), ids, good };
  const traceId = opts?.traceId;
  // Recall traces live beside the last recall, so only a store with the lastRecall group can link one.
  const appliedIds = traceId === undefined
    ? await entryWrites.applyOutcome(write)
    : await narrowStore(store, 'lastRecall').lastRecall.applyTracedOutcome(write, traceId);
  return { applied: appliedIds.length, appliedIds };
}

/** The last recall's ids and its trace sit with the store's lastRecall group, which only the CLI and context write; a
 * store without it is refused. `ids` holds only the ids applied in ctx.tenantId: the index is not tenant-scoped, so the
 * ids read from it are never returned. */
export interface OutcomeForLastRecallResult {
  applied: number;
  ids: string[];
}
export async function outcomeForLastRecall(ctx: StoreContext, good: boolean): Promise<OutcomeForLastRecallResult> {
  const lastRecall = ctx.store.lastRecall;
  // Its own 501 text, since a client of such a store can still
  // apply the outcome by sending the ids its recall returned.
  if (lastRecall === undefined) {
    throw new HttpError(501, 'this store keeps no last recall: send the ids your recall returned');
  }
  const ids = await lastRecall.applyOutcomeToLast(
    { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor) },
    good,
  );
  return { applied: ids.length, ids };
}
