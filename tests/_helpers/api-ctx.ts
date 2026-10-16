import { adminActor, type Actor, type StoreContext } from '../../src/api/index.js';
import { sqliteReach, sqliteStore } from '../../src/store/sqlite/store.js';

/** A test Context whose store holds every group, as the CLI's composition root hands it. */
export type FullContext = StoreContext;

/** A Context on hippo.db under `hippoRoot` with its store built, as the CLI's composition root hands it. */
export function apiCtx(hippoRoot: string, tenantId = 'default', actor: Actor = adminActor('test')): FullContext {
  const store = sqliteStore(hippoRoot);
  return { hippoRoot, tenantId, actor, store, reach: sqliteReach(hippoRoot, store) };
}
