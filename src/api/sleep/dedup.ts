// `hippo dedup`: one pass over the whole store, outside a sleep, with the deletions under the
// caller's name.

import { deduplicateStore, type DedupResult } from '../../domain/consolidate/dedupe.js';
import { requireHostAdmin } from '../types.js';
import type { HippoDbContext } from '../hippo-db-context.js';

export type { DedupResult };

/** Removes the weaker copy of each same-text distilled row, tenant by tenant across the whole
 * store, so only a host admin may. */
export async function dedupWholeStore(
  ctx: HippoDbContext,
  opts: { readonly dryRun: boolean },
): Promise<DedupResult> {
  requireHostAdmin(ctx, 'Deduplicating the store');
  return deduplicateStore(ctx.store, { dryRun: opts.dryRun, actor: ctx.actor.subject });
}
