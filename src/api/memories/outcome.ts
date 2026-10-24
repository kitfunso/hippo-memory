// Outcome feedback on recalled memories.

import { scopeReaderOf } from '../../base/scope/recall-scope.js';
import type { ContextWith, EntryContext } from '../types.js';

/** An id outside ctx.tenantId, or in someone else's personal scope, is skipped, so a stale id never fails the call.
 *  `appliedIds` holds only the ids applied: a caller that answers across tenants returns it, never the ids it was sent.
 */
export interface OutcomeResult {
  applied: number;
  appliedIds: string[];
}
/** Explicit ids may follow no recall at all, so no trace is linked; outcomeForLastRecall links the last one. */
export async function outcome(ctx: EntryContext, ids: ReadonlyArray<string>, good: boolean): Promise<OutcomeResult> {
  const write = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ...scopeReaderOf(ctx.actor), ids, good };
  const appliedIds = await ctx.store.entryWrites.applyOutcome(write);
  return { applied: appliedIds.length, appliedIds };
}

/** The last recall's ids and its trace sit with the store's lastRecall group, which only the CLI and context write.
 * `ids` holds only the ids applied in ctx.tenantId: the index is not tenant-scoped, so the ids read from it are never
 * returned. */
export interface OutcomeForLastRecallResult {
  applied: number;
  ids: string[];
}
export async function outcomeForLastRecall(
  ctx: ContextWith<'lastRecall'>,
  good: boolean,
): Promise<OutcomeForLastRecallResult> {
  const ids = await ctx.store.lastRecall.applyOutcomeToLast(
    { tenantId: ctx.tenantId, actor: ctx.actor.subject, ...scopeReaderOf(ctx.actor) },
    good,
  );
  return { applied: ids.length, ids };
}
