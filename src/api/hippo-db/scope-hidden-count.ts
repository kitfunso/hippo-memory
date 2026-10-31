// How many rows the scope rule hid from a recall, for `hippo explain`, read through hippo.db's
// local tier.
import { passesCliRecallScopeFilter } from '../../base/scope/recall-scope.js';
import type { HippoDbContext, HippoDbStore } from '../hippo-db-context.js';

/** How many of `query`'s search candidates the scope rule hides from a recall asking for `requested`; the read is
 *  window-capped, so this is a floor on a large store. */
export async function scopeHiddenCount(
  ctx: HippoDbContext,
  query: string,
  global: HippoDbStore | undefined,
  requested: string | undefined,
): Promise<number> {
  const probes = [ctx.store.hippoDb.sharing, global?.hippoDb.sharing].map(
    async (sharing) => (await sharing?.searchEntries(query, undefined, ctx.tenantId)) ?? [],
  );
  const probe = (await Promise.all(probes)).flat();
  return probe.filter((e) => !passesCliRecallScopeFilter(e.scope ?? null, requested)).length;
}
