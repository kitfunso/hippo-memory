// Outcome feedback on recalled memories.

import { scopeReaderOf } from '../../base/scope/recall-scope.js';
import type { EntryContext } from '../types.js';

/** An id outside ctx.tenantId, or in someone else's personal scope, is skipped, so a stale id never fails the call.
 *  `appliedIds` holds only the ids applied: a caller that answers across tenants returns it, never the ids it was sent.
 */
export interface OutcomeResult {
  applied: number;
  appliedIds: string[];
}
/** Explicit ids may follow no recall at all, so no trace is linked; outcomeForLastRecall links
 * the last one. */
export async function outcome(
  ctx: EntryContext,
  ids: ReadonlyArray<string>,
  good: boolean,
): Promise<OutcomeResult> {
  const write = {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    ids,
    good,
  };
  const appliedIds = await ctx.store.entryWrites.applyOutcome(write);
  return { applied: appliedIds.length, appliedIds };
}
