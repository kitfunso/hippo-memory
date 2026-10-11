// Creating a store for `hippo init`: the database, its mirror folders and first-run setup.

import { initStore } from '../store/open.js';
import { requireHostAdmin, type Context } from './types.js';

/** Create the store at `ctx.hippoRoot`, or finish setting up one that exists; a store holds every tenant, so the host admin only. */
export function initMemoryStore(ctx: Context): void {
  requireHostAdmin(ctx, 'Creating a store');
  initStore(ctx.hippoRoot);
}
