import { adminActor, type Actor } from '../../src/api/index.js';
import { contextReach, type ContextReach, type ContextWith } from '../../src/api/types.js';
import { loadConfig } from '../../src/core/config.js';
import type { HippoStore, OptionalGroup } from '../../src/store/port.js';
import { sqliteReach, sqliteStore } from '../../src/store/sqlite/store.js';

/** A test Context whose store holds every group, as the CLI's composition root hands it. */
export type FullContext = ContextWith<OptionalGroup>;

/** The reach a root sets for `store` on `hippoRoot`, with the global store's config read as the CLI reads it. */
export function testReach(hippoRoot: string, store: HippoStore): ContextReach {
  return contextReach(sqliteReach(hippoRoot, store), loadConfig);
}

/** A Context on hippo.db under `hippoRoot` with its store built, as the CLI's composition root hands it. */
export function apiCtx(hippoRoot: string, tenantId = 'default', actor: Actor = adminActor('test')): FullContext {
  const store = sqliteStore(hippoRoot);
  return { hippoRoot, tenantId, actor, store, reach: testReach(hippoRoot, store), config: loadConfig(hippoRoot) };
}
