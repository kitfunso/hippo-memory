import { adminActor, type Actor, type StoreContext } from '../../src/api/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

/** A Context on hippo.db under `hippoRoot` with its store built, as the CLI's composition root hands it. */
export function apiCtx(hippoRoot: string, tenantId = 'default', actor: Actor = adminActor('test')): StoreContext {
  return { hippoRoot, tenantId, actor, store: sqliteStore(hippoRoot) };
}
