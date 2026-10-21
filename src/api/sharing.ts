// Copying memories between a folder's store and the operator's global store: share one or the best by transfer score,
// list the projects that shared, and sync the global rows down. The caller's tenant scopes each read of its own store.

import type { MemoryEntry } from '../base/memory/memory.js';
import { ALL_TENANTS } from '../base/util/tenant.js';
import { syncGlobalToLocal } from '../domain/sharing/global-sync.js';
import { autoShare, listPeers, shareMemory } from '../domain/sharing/share.js';
import { requireHostAdmin, type Context, type ContextWith, type ContextReach } from './types.js';

export { AUTO_SHARE_MIN_SCORE, transferScore } from '../domain/sharing/share.js';

/** One project's rows in the global store. */
export interface SharePeer {
  readonly project: string;
  readonly count: number;
  readonly latest: string;
}

// A root's reach sets it for a store kept in a folder, so only a context built without a reach lacks it.
function globalTargetOf(ctx: Context, action: string): NonNullable<ContextReach['globalTarget']> {
  const target = ctx.reach?.globalTarget;
  if (target === undefined) throw new Error(`${action} needs ctx.reach.globalTarget, the global store`);
  return target;
}

/** Copies one of the caller's memories to the global store; null when its transfer score is too low and `force` is
 * off. */
export async function shareToGlobal(
  ctx: ContextWith<'folderFiles'>,
  id: string,
  opts: { readonly force: boolean },
): Promise<MemoryEntry | null> {
  return shareMemory(ctx, globalTargetOf(ctx, 'share'), id, { force: opts.force, tenantId: ctx.tenantId });
}

/** The caller's memories whose transfer score reaches `minScore`, copied to the global store unless `dryRun`. */
export async function autoShareToGlobal(
  ctx: ContextWith<'sharing' | 'folderFiles'>,
  opts: { readonly minScore: number; readonly dryRun: boolean },
): Promise<MemoryEntry[]> {
  return autoShare(ctx, globalTargetOf(ctx, 'auto-share'), { ...opts, tenantId: ctx.tenantId });
}

/** The projects that shared into the global store: the caller's tenant, or every tenant for the host's operator. */
export async function sharePeers(ctx: Context, opts: { readonly allTenants?: boolean } = {}): Promise<SharePeer[]> {
  if (opts.allTenants === true) requireHostAdmin(ctx, "Listing every tenant's peers");
  return listPeers(globalTargetOf(ctx, 'peers'), opts.allTenants === true ? ALL_TENANTS : ctx.tenantId);
}

/** Copies the global rows the caller's store lacks into it; other projects' rows only with `includeCrossProject`. */
export async function syncFromGlobal(
  ctx: ContextWith<'sharing' | 'folderFiles'>,
  opts: { readonly includeCrossProject: boolean },
): Promise<number> {
  return syncGlobalToLocal({ store: ctx.store, config: ctx.config }, globalTargetOf(ctx, 'sync'), opts);
}
