import { adminActor, type Actor } from '../../src/api/index.js';
import type { ContextReach } from '../../src/api/types.js';
import { contextReach, coreEnrichment, hasHippoDb, type HippoDbContext } from '../../src/api/hippo-db-context.js';
import { loadConfig } from '../../src/host/config-file.js';
import { type ProjectIdentity } from '../../src/base/scope/project-identity.js';
import { resolveProjectIdentity } from '../../src/host/project-identity.js';
import type { HippoStore } from '../../src/base/ports/store.js';
import { inSqliteSession, sqliteReach, sqliteStore } from '../../src/store/sqlite/store.js';
import type { RequestStores } from '../../src/db/request-stores.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import { testInfra } from './infra.js';
import { evalStoreRules } from '../../src/infra/eval-switches.js';

/** A test Context on hippo.db with its local tier, as the CLI's composition root hands it; the folder rides beside it
 * for the tests that reopen it. */
export type FullContext = HippoDbContext & { readonly hippoRoot: string };

/** The reach a root sets for `store` on `hippoRoot`, with the global store's config read as the CLI reads it, and the
 * store as the ledger home when it keeps a ledger. */
export function testReach(hippoRoot: string, store: HippoStore): ContextReach {
  const ledger = hasHippoDb(store)
    ? { ledger: store.hippoDb.ledger, folderFiles: store.hippoDb.folderFiles, config: loadConfig(hippoRoot) }
    : undefined;
  return contextReach(sqliteReach({ hippoRoot, store }), loadConfig, resolveEmbeddingProvider, ledger);
}

/** A Context on hippo.db under `hippoRoot` with its store built at the eval rules and clock, as the CLI root hands it. */
export function apiCtx(hippoRoot: string, tenantId = 'default', actor: Actor = adminActor('test')): FullContext {
  const store = sqliteStore(hippoRoot, evalStoreRules(undefined));
  const reach = testReach(hippoRoot, store);
  const config = loadConfig(hippoRoot);
  return { hippoRoot, tenantId, actor, store, reach, config, infra: testInfra(), enrich: coreEnrichment(store) };
}

/** `ctx` with its store, and the local tier it carries, on `session`, so a run of calls shares one handle per store,
 * as a CLI command's do. */
export function onSession<C extends { readonly store: HippoStore }>(ctx: C, session: RequestStores): C {
  const store = inSqliteSession(ctx.store, session);
  const enrich = coreEnrichment(store);
  return { ...ctx, store, ...(enrich && { enrich }) };
}

/** The project this test process runs in, which contextGet read for itself before the surface named it. */
export function cwdProject(): ProjectIdentity {
  return resolveProjectIdentity(process.cwd());
}
