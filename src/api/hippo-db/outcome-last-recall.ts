// Outcome feedback on the last recall, which hippo.db's local tier keeps for the CLI.

import { scopeReaderOf } from '../../base/scope/recall-scope.js';
import type { ContextWith } from '../types.js';

/** The last recall's ids and its trace sit with the store's lastRecall group, which only the CLI
 * and context write. `ids` holds only the ids applied in ctx.tenantId: the index is not
 * tenant-scoped, so the ids read from it are never returned. */
export interface OutcomeForLastRecallResult {
  applied: number;
  ids: string[];
}
export async function outcomeForLastRecall(
  ctx: ContextWith<'lastRecall'>,
  good: boolean,
): Promise<OutcomeForLastRecallResult> {
  const ids = await ctx.store.hippoDb.lastRecall.applyOutcomeToLast(
    { tenantId: ctx.tenantId, actor: ctx.actor.subject, ...scopeReaderOf(ctx.actor) },
    good,
  );
  return { applied: ids.length, ids };
}
