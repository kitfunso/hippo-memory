import { recallScopeFilter } from '../../base/scope/recall-scope.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { auditQueryFields } from '../../base/records/audit-report.js';
import { rankBothStores } from '../../domain/sharing/search-both.js';
import { searchByEngine } from '../../domain/search/engine.js';
import { vectorSourceOf } from '../../domain/search/hybrid.js';
import type { HybridVectorCandidates, VectorSource } from '../../domain/search/vector.js';
import type { SearchResult } from '../../base/rank/search-types.js';
import type { ContextResultEntry } from './context-types.js';
import { heldIds } from '../recall/finish.js';
import type { Context } from '../types.js';
import type { AmbientLoadResult } from '../../base/ports/store/context-reads.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { type ContextPlan, globalStoreInReach, globalInReach } from './context-plan.js';
import type { ContextAdmission, ContextPools } from './context-pools.js';

export interface SelectBySearchOptions {
  readonly plan: ContextPlan;
  readonly left: number;
  readonly pools: ContextPools;
  readonly admission: ContextAdmission;
}

/** Real query: hybrid search over both stores, or physics/hybrid over the local rows; emits the
 * 'recall' audit row. */
export async function selectBySearch(
  ctx: Context,
  { plan, left, pools, admission }: SelectBySearchOptions,
): Promise<ContextResultEntry[]> {
  const minResults = plan.cost ? 0 : undefined;
  const results =
    plan.hasGlobal && !plan.primaryIsGlobal
      ? await searchBothStores(ctx, plan, {
          left,
          minResults,
          pools,
          admit: admission.bothStoresAdmit,
        })
      : await searchLocalRows(ctx, plan, {
          left,
          minResults,
          localEntries: pools.local.entries,
          admit: admission.admit,
        });
  await auditContextRecall(ctx, plan, results.length);
  return results;
}

interface SearchBothStoresOptions {
  readonly left: number;
  readonly minResults: number | undefined;
  readonly pools: ContextPools;
  readonly admit: (e: MemoryEntry) => boolean;
}

async function searchBothStores(
  ctx: Context,
  plan: ContextPlan,
  options: SearchBothStoresOptions,
): Promise<ContextResultEntry[]> {
  const { left, minResults, pools, admit } = options;
  const { cost, price } = plan;
  const isGlobalHit = await globalHitTest(ctx, plan, pools);
  const merged = await rankBothStores({
    query: plan.query,
    sources: bothVectorSources(ctx, plan),
    entries: { local: pools.local.entries, global: pools.global.entries },
    vectorCandidates: contextVectorSpec(ctx, plan, admit),
    options: {
      ...engineSettings(ctx, plan),
      budget: left,
      minResults,
      cost: cost && ((r) => price(r.entry, isGlobalHit(r.entry))),
    },
  });
  return merged.map((r) => ({
    entry: r.entry,
    score: r.score,
    tokens: price(r.entry, isGlobalHit(r.entry)),
    isGlobal: isGlobalHit(r.entry),
  }));
}

function engineSettings(ctx: Context, plan: ContextPlan) {
  return {
    scope: plan.activeScope,
    runtime: ctx.config.runtime,
    cwd: ctx.infra.machine.cwd,
    switches: ctx.infra.evalSwitches,
    now: plan.now,
  };
}

async function globalHitTest(
  ctx: Context,
  plan: ContextPlan,
  pools: ContextPools,
): Promise<(e: MemoryEntry) => boolean> {
  const poolIds = (pool: AmbientLoadResult): string[] =>
    [...pool.entries, ...(pool.recall ?? [])].map((e) => e.id);
  const localIds = new Set(poolIds(pools.local));
  const alsoLocal = await heldIds(
    plan.local.store,
    poolIds(pools.global).filter((id) => !localIds.has(id)),
    ctx.tenantId,
  );
  return (e: MemoryEntry): boolean => !localIds.has(e.id) && !alsoLocal.has(e.id);
}

function bothVectorSources(ctx: Context, plan: ContextPlan) {
  return {
    local: vectorSourceOf({
      store: plan.local.store,
      config: plan.config,
      onHippoDb: ctx.reach?.isHippoDb,
      embedderFor: ctx.infra.embedderFor,
    }),
    global: globalVectorSource(ctx),
  };
}

function contextVectorSpec(
  ctx: Context,
  plan: ContextPlan,
  admit: (e: MemoryEntry) => boolean,
): HybridVectorCandidates {
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(plan.exactScope, 'exact', plan.ownScope),
    includeSuperseded: false,
    admit,
  };
}

interface SearchLocalRowsOptions {
  readonly left: number;
  readonly minResults: number | undefined;
  readonly localEntries: MemoryEntry[];
  readonly admit: (e: MemoryEntry) => boolean;
}

async function searchLocalRows(
  ctx: Context,
  plan: ContextPlan,
  options: SearchLocalRowsOptions,
): Promise<ContextResultEntry[]> {
  const { left, minResults, localEntries, admit } = options;
  const { cost, price, primaryIsGlobal, query, config: ctxConfig } = plan;
  const usePhysicsCtx = ctxConfig.physics?.enabled !== false;
  const localCost = cost && ((r: SearchResult) => price(r.entry, primaryIsGlobal));
  const vectorCandidates = contextVectorSpec(ctx, plan, admit);
  const store = plan.local.store;
  const ctxResults = await searchByEngine({
    source: vectorSourceOf({
      store,
      config: ctxConfig,
      onHippoDb: ctx.reach?.isHippoDb,
      embedderFor: ctx.infra.embedderFor,
    }),
    query,
    pool: localEntries,
    physics: usePhysicsCtx ? ctxConfig.physics : null,
    options: {
      ...engineSettings(ctx, plan),
      budget: left,
      minResults,
      cost: localCost,
      vectorCandidates,
    },
  });
  return ctxResults.map((r) => ({
    entry: r.entry,
    score: r.score,
    tokens: price(r.entry, primaryIsGlobal),
    isGlobal: primaryIsGlobal,
  }));
}

async function auditContextRecall(
  ctx: Context,
  plan: ContextPlan,
  resultCount: number,
): Promise<void> {
  const row: AppendAuditOptions = {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    op: 'recall',
    metadata: { ...auditQueryFields(plan.query), results: resultCount, mode: 'context' },
  };
  if (plan.hasLocal) await plan.local.store.appendAuditEvents([row]);
  if (plan.hasGlobal && !plan.primaryIsGlobal) {
    await globalStoreInReach(ctx).appendAuditEvents([row]);
  }
}

function globalVectorSource(ctx: Context): VectorSource | undefined {
  const { store, config } = globalInReach(ctx);
  return vectorSourceOf({ store, config, onHippoDb: true, embedderFor: ctx.infra.embedderFor });
}
