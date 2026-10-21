import { adminActor, type Actor } from '../../src/api/index.js';
import { contextReach, type ContextReach, type ContextWith } from '../../src/api/types.js';
import { loadConfig } from '../../src/base/config/config.js';
import { resolveProjectIdentity, type ProjectIdentity } from '../../src/base/scope/project-identity.js';
import type { HippoStore, OptionalGroup } from '../../src/store/port.js';
import { sqliteReach, sqliteStore } from '../../src/store/sqlite/store.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import { testInfra } from './infra.js';

/** A test Context whose store holds every group and its local files, as the CLI's composition root hands it; the
 * folder rides beside it for the tests that reopen it. */
export type FullContext = ContextWith<OptionalGroup> & { readonly hippoRoot: string };

/** The reach a root sets for `store` on `hippoRoot`, with the global store's config read as the CLI reads it. */
export function testReach(hippoRoot: string, store: HippoStore): ContextReach {
  return contextReach(sqliteReach(hippoRoot, store), loadConfig, resolveEmbeddingProvider);
}

/** A Context on hippo.db under `hippoRoot` with its store built, as the CLI's composition root hands it. */
export function apiCtx(hippoRoot: string, tenantId = 'default', actor: Actor = adminActor('test')): FullContext {
  const store = sqliteStore(hippoRoot);
  const reach = testReach(hippoRoot, store);
  return { hippoRoot, tenantId, actor, store, reach, config: loadConfig(hippoRoot), infra: testInfra() };
}

/** The project this test process runs in, which contextGet read for itself before the surface named it. */
export function cwdProject(): ProjectIdentity {
  return resolveProjectIdentity(process.cwd());
}
