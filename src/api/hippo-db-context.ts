// The context a local feature's api module takes: a store that carries hippo.db's local tier.
// Only a surface that proved the tier at composition builds one, so no core path reaches it.
import type { HippoDbStore, HippoDbTier } from '../store/sqlite/hippo-db.js';
import { NoLocalTierError } from '../base/util/store-blocked.js';
import type { HippoConfig } from '../base/config/config.js';
import type { ConfiguredFolder } from '../base/config/configured-folder.js';
import type { EmbedderFor } from '../base/ports/embedder.js';
import type { StoreReach } from '../base/ports/store.js';
import type { Context, ContextReach, LedgerHome } from './types.js';
import type { CoreEnrichment, GlobalEnrichment, SleepCount } from './enrichment.js';

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

/** `store` with its local tier; a store without one throws the 501 every local path answers. */
export function requireHippoDb<S extends Context['store']>(store: S): S & HippoDbTier {
  if (hasHippoDb(store)) return store;
  throw new NoLocalTierError(store.kind);
}

/** `ctx` with its store's local tier proved, as a published entry resolves it at run time; a
 * store without one throws requireHippoDb's 501. */
export function withHippoDb<C extends { readonly store: Context['store'] }>(
  ctx: C,
): C & { readonly store: C['store'] & HippoDbTier } {
  return { ...ctx, store: requireHippoDb(ctx.store) };
}

/** The reach's global write target with its local tier proved and an embedder filled in: the
 * host's own, else the context's. Unset with no target, or one whose store has no tier to copy
 * into. */
export function globalTargetOf(
  ctx: Pick<Context, 'reach' | 'infra'>,
): ConfiguredFolder<HippoDbStore> | undefined {
  const target = ctx.reach?.globalTarget;
  if (target === undefined || !hasHippoDb(target.store)) return undefined;
  const embedderFor = target.embedderFor ?? ctx.infra.embedderFor;
  return { ...target, store: target.store, embedderFor };
}

/** What a core path reads from `store`'s local tier; unset on a store without one. A root passes
 * the request's own store, so each call runs under that request's deadline and session. */
export function coreEnrichment(store: Context['store']): CoreEnrichment | undefined {
  if (!hasHippoDb(store)) return undefined;
  const { hippoDb } = store;
  const { lastRecall, sessions, readiness, graphReads, ledger, folderFiles, stats } = hippoDb;
  // Read at the count, so a call that writes nothing never touches the reports group.
  const sleepCount: SleepCount = {
    createdSinceLastSleep: (tenantId, now) => hippoDb.reports.createdSinceLastSleep(tenantId, now),
  };
  return {
    lastRecall,
    handoff: sessions,
    readiness,
    graph: graphReads,
    ledger,
    folderFiles,
    sleepCount,
    remembered: stats,
  };
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
