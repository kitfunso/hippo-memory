// Creating a store for `hippo init`: the database, its mirror folders and first-run setup.

import { requireHostAdmin } from './types.js';
import type { HippoDbContext, HippoDbTier } from './hippo-db-context.js';

/** A store holds every tenant, so only the host admin creates one. */
export async function initMemoryStore(ctx: HippoDbContext): Promise<void> {
  requireHostAdmin(ctx, 'Creating a store');
  await ensureStoreFiles(ctx);
}

/** For a write that may come before any `hippo init`: a global capture, a zero-install MCP run. */
export function ensureStoreFiles(folder: { readonly store: HippoDbTier }): Promise<void> {
  return folder.store.hippoDb.folderFiles.ensure();
}
