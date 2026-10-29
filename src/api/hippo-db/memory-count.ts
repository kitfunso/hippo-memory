// The whole store's row count, which hippo.db's reports answer in SQL.
import { requireHostAdmin, type ContextWith } from '../types.js';

/** How many memory rows the whole store holds, counted in SQL. */
export async function memoryCountAll(ctx: ContextWith<'reports'>): Promise<number> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return ctx.store.hippoDb.reports.countEntries();
}
