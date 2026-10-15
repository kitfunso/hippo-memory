import { adminActor, type Actor, type ContextWith } from '../../src/api/index.js';
import type { StoreGroup } from '../../src/store/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

/** A test Context whose store holds every group, as the CLI's composition root hands it. */
export type FullContext = ContextWith<StoreGroup>;

/** A Context on hippo.db under `hippoRoot` with its store built, as the CLI's composition root hands it. */
export function apiCtx(hippoRoot: string, tenantId = 'default', actor: Actor = adminActor('test')): FullContext {
  return { hippoRoot, tenantId, actor, store: sqliteStore(hippoRoot) };
}
