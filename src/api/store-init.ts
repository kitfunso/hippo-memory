// Creating a store for `hippo init`: the database, its mirror folders and first-run setup.

import { requireHostAdmin } from './types.js';
import type { HippoDbContext } from './hippo-db-context.js';

/** Create `ctx`'s store, or finish setting up one that exists; a store holds every tenant, so
 * the host admin only. */
export async function initMemoryStore(ctx: HippoDbContext): Promise<void> {
  requireHostAdmin(ctx, 'Creating a store');
  await ctx.store.hippoDb.folderFiles.ensure();
}
