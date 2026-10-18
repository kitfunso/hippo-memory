// Creating a store for `hippo init`: the database, its mirror folders and first-run setup.

import { requireHostAdmin, type ContextWith } from './types.js';

/** Create the store at `ctx.hippoRoot`, or finish setting up one that exists; a store holds every tenant, so the host
 * admin only. */
export function initMemoryStore(ctx: ContextWith<'localFiles'>): void {
  requireHostAdmin(ctx, 'Creating a store');
  ctx.store.localFiles.ensureFiles();
}
