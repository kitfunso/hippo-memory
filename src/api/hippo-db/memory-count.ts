// The whole store's row count, which hippo.db's reports answer in SQL.
import { requireHostAdmin } from '../types.js';
import type { HippoDbContext } from '../hippo-db-context.js';

/** How many memory rows the whole store holds, counted in SQL. */
export async function memoryCountAll(ctx: HippoDbContext): Promise<number> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return ctx.store.hippoDb.reports.countEntries();
}
