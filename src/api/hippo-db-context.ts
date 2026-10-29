// The context a local feature's api module takes: a store that carries hippo.db's local tier.
// Only a surface that proved the tier at composition builds one, so no core path reaches it.
import type { HippoDbTier } from '../store/sqlite/hippo-db.js';
import type { HippoConfig } from '../base/config/config.js';
import type { EmbedderFor } from '../base/ports/embedder.js';
import type { StoreReach } from '../base/ports/store.js';
import type { Context, ContextReach, LedgerHome } from './types.js';
import type { CoreEnrichment, GlobalEnrichment } from './enrichment.js';

export type { HippoDbStore, HippoDbTier } from '../store/sqlite/hippo-db.js';

export interface HippoDbContext extends Context {
  /** The store with the tier on it, so the one rebind a request makes of `store` binds both. */
  readonly store: Context['store'] & HippoDbTier;
}

/** Whether `store` carries hippo.db's local tier; a surface asks once, as it binds a local route
 * or tool. */
export function hasHippoDb<S extends Context['store']>(store: S): store is S & HippoDbTier {
  // An unset tier counts as absent, as hasGroup counts an unset group.
  return 'hippoDb' in store && store.hippoDb !== undefined;
}

/** What a core path reads from `store`'s local tier; unset on a store without one. A root passes
 * the request's own store, so each call runs under that request's deadline and session. */
export function coreEnrichment(store: Context['store']): CoreEnrichment | undefined {
  if (!hasHippoDb(store)) return undefined;
  const { lastRecall, sessions, readiness, graphReads, ledger, folderFiles } = store.hippoDb;
  return { lastRecall, handoff: sessions, readiness, graph: graphReads, ledger, folderFiles };
}

/** What a core path reads from the global store's local tier; unset on a store without one. */
export function globalEnrichment(store: Context['store']): GlobalEnrichment | undefined {
  if (!hasHippoDb(store)) return undefined;
  const { graphReads, ledger, folderFiles } = store.hippoDb;
  return { graph: graphReads, ledger, folderFiles };
}

/** A root's reach with the global store's config loaded beside it; `configAt` is the root's own
 * loader, and a promote embeds its copy with `embedderFor`. */
export function contextReach(
  reach: StoreReach,
  configAt: (root: string) => HippoConfig,
  embedderFor: EmbedderFor,
  ledger?: LedgerHome,
): ContextReach {
  const { global, globalTarget, ...rest } = reach;
  // Both name the operator's global store, so one load serves both.
  let last: { readonly root: string; readonly config: HippoConfig } | undefined;
  const at = (root: string): HippoConfig => {
    if (last?.root !== root) last = { root, config: configAt(root) };
    return last.config;
  };
  let withConfig: ContextReach = ledger === undefined ? rest : { ...rest, ledger };
  if (global !== undefined) {
    const enrich = globalEnrichment(global.store);
    withConfig = { ...withConfig, global: { ...global, config: at(global.root), enrich } };
  }
  if (globalTarget !== undefined) {
    withConfig = {
      ...withConfig,
      globalTarget: { store: globalTarget.store, config: at(globalTarget.root), embedderFor },
    };
  }
  return withConfig;
}
