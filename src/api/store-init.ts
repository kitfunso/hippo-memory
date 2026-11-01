// Creating a store for `hippo init`: the database, its mirror folders and first-run setup.

import { requireHostAdmin } from './types.js';
import { hasHippoDb, type HippoDbContext } from './hippo-db-context.js';
import type { HippoDbTier } from '../base/ports/hippo-db.js';
import type { HippoStore } from '../base/ports/store.js';

/** A store holds every tenant, so only the host admin creates one. */
export async function initMemoryStore(ctx: HippoDbContext): Promise<void> {
  requireHostAdmin(ctx, 'Creating a store');
  await ensureStoreFiles(ctx.store);
}

/** For a write that may come before any `hippo init` (a global capture, a zero-install MCP run):
 * creates the folder of a store that keeps one; false for an absent store or one that keeps none. */
export async function ensureStoreFiles(
  store: HippoStore | HippoDbTier | undefined,
): Promise<boolean> {
  if (store === undefined || !hasHippoDb(store)) return false;
  await store.hippoDb.folderFiles.ensure();
  return true;
}
