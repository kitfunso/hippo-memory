// What the engines rank: the pool a recall loads and the search over it.
import { oneCopyPerMemory } from '../context/context-select.js';
import { DEFAULT_GRAPH_STREAM_WEIGHT } from '../../domain/graph/stream.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { rankMultihop } from '../../domain/search/multihop.js';
import {
  passesCliRecallScopeFilter,
  passesScopeFilterForRecall,
  recallScopeFilter,
} from '../../base/scope/recall-scope.js';
import { currentEntries } from '../../domain/search/as-of.js';
import { rankStrength } from '../../domain/search/boosts.js';
import { rankHybrid, vectorSourceOf, type HybridRankOptions } from '../../domain/search/hybrid.js';
import {
  DEFAULT_SEARCH_CANDIDATE_LIMIT,
  type RankTime,
  type SearchResult,
} from '../../base/rank/search-types.js';
import { rankBothStores } from '../../domain/sharing/search-both.js';
import { estimateTokens } from '../../base/util/token-text.js';
import type { HybridVectorCandidates } from '../../domain/search/vector.js';
import type { RecallProfile } from './profiles.js';
import type {
  RankRecallCtx,
  RecallGraphStream,
  RankRecallOptions,
  SettledOptions,
} from './pipeline.js';

interface RecallPool {
  local: MemoryEntry[];
  global: MemoryEntry[];
  total: number;
  dropped: number;
}

interface PoolScope {
  /** An explicit --scope unlocks that envelope scope. The regex-only `<source>:private:*` deny
   * is the JS half of the rule. */
  requested: string | undefined;
  /** An as-of read needs the rows a later write superseded. */
  loadSuperseded: boolean;
}

export function poolScope(opts: RankRecallOptions): PoolScope {
  return {
    requested: opts.explicitScope || undefined,
    loadSuperseded: opts.includeSuperseded || Boolean(opts.asOf),
  };
}

/** The JS half of the load's scope rule: the CLI's additive unlock, or an API caller's exact
 * scope and own scope. */
function poolAdmits(opts: RankRecallOptions): (e: MemoryEntry) => boolean {
  const { requested } = poolScope(opts);
  return opts.scopeMode === 'exact'
    ? (e) => passesScopeFilterForRecall(e.scope ?? null, requested, opts.ownScope)
    : (e) => passesCliRecallScopeFilter(e.scope ?? null, requested);
}

export async function loadRecallPool(
  ctx: RankRecallCtx,
  opts: RankRecallOptions,
  profile: RecallProfile,
): Promise<RecallPool> {
  const { requested, loadSuperseded } = poolScope(opts);
  const load = {
    limit: Math.max(opts.scorerWindow ?? DEFAULT_SEARCH_CANDIDATE_LIMIT, profile.candidateFloor),
    tenantId: ctx.tenantId,
    requestedScope: requested,
    explicitScopeMode: opts.scopeMode ?? 'additive',
    includeSuperseded: loadSuperseded,
    originProjects: opts.originProjects,
    ownScope: opts.ownScope,
  };
  // The two stores are independent, so their reads overlap; Promise.all keeps the local-then-global
  // order.
  const reads = await Promise.all([
    ctx.store.searchRecallEntries(opts.query, load),
    ctx.global ? ctx.global.store.searchRecallEntries(opts.query, load) : Promise.resolve([]),
  ]);
  let [local, global] = reads;
  // The SQL load already left out some rows, so the total is taken before the JS filters, which
  // normally drop nothing.
  const total = local.length + global.length;
  const passes = poolAdmits(opts);
  local = local.filter(passes);
  global = global.filter(passes);
  const currentness = { asOf: opts.asOf, includeSuperseded: opts.includeSuperseded };
  local = currentEntries(local, currentness);
  global = currentEntries(global, currentness);
  return { local, global, total, dropped: total - (local.length + global.length) };
}

interface PoolSearch {
  readonly pool: RecallPool;
  /** The scope the engines boost, by the profile's `scopeBoost`; undefined leaves the engine its
   * runtime scope. */
  readonly scope: string | null | undefined;
}

type EngineOptions = RankTime &
  Pick<
    HybridRankOptions,
    | 'budget'
    | 'cost'
    | 'minResults'
    | 'includeSuperseded'
    | 'asOf'
    | 'runtime'
    | 'cwd'
    | 'switches'
    | 'signal'
  >;

/** What every engine ranks under, built once so a new ranking input reaches all three search
 * modes. */
function engineOptions(ctx: RankRecallCtx, opts: SettledOptions): EngineOptions {
  return {
    budget: opts.budget,
    cost: opts.cost,
    minResults: opts.minResults,
    includeSuperseded: opts.includeSuperseded,
    asOf: opts.asOf,
    runtime: ctx.config.runtime,
    cwd: ctx.cwd,
    switches: ctx.switches,
    now: ctx.now,
    signal: ctx.signal,
  };
}

function graphStreamSearch(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  graphStream: RecallGraphStream,
  { pool, scope }: PoolSearch,
): Promise<SearchResult[]> {
  const { mmr, mmrLambda } = opts;
  noteGraphStreamLimits(ctx, pool);
  // With seedCount or fewer candidates every one is a seed and the stream degrades to the 2-list
  // fusion.
  return rankHybrid(opts.query, pool.local, {
    ...engineOptions(ctx, opts),
    source: vectorSourceOf(ctx),
    mmr,
    mmrLambda,
    scope,
    scoring: 'rrf',
    graphStream: {
      weight: DEFAULT_GRAPH_STREAM_WEIGHT,
      tenantId: ctx.tenantId,
      hops: graphStream.hops,
      seedCount: graphStream.seeds,
    },
  });
}

/** Says why the graph stream will not run as asked, rather than no-op. */
function noteGraphStreamLimits(ctx: RankRecallCtx, pool: RecallPool): void {
  // Without embeddings rankHybrid falls back to BM25-only and the stream is inert.
  if (!ctx.embedderFor(ctx.config.embeddings).isAvailable()) {
    ctx.note?.(
      '[note] --graph-stream needs embeddings (rrf fusion); none available, so the graph stream is inert. Run ' +
        '`hippo embed` first.',
    );
  }
  if (ctx.global && pool.global.length > 0) {
    ctx.note?.(
      '[note] --graph-stream searches the local store only; global graph fusion is a follow-up.',
    );
  }
}

function multihopPoolSearch(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  pool: RecallPool,
): SearchResult[] {
  const { cost } = opts;
  // Unlike rankBothStores below, multihop ranks one pooled list, so a shared memory's two copies
  // both compete.
  const strength = rankStrength({ switches: ctx.switches, runtime: ctx.config.runtime });
  const allEntries = oneCopyPerMemory(pool.local, pool.global, ctx.now, strength).flat();
  const globalIds = new Set(pool.global.map((e) => e.id));
  const localIds = new Set(pool.local.map((e) => e.id));
  const fromGlobal = (id: string): boolean => globalIds.has(id) && !localIds.has(id);
  const results = rankMultihop(opts.query, allEntries, {
    ...engineOptions(ctx, opts),
    cost: cost && ((r) => cost({ ...r, isGlobal: fromGlobal(r.entry.id) })),
    scope: ctx.config.runtime?.activeScope ?? null,
  });
  return results.map((r) => ({ ...r, isGlobal: fromGlobal(r.entry.id) }));
}

function poolVectorCandidates(ctx: RankRecallCtx, opts: RankRecallOptions): HybridVectorCandidates {
  const { requested, loadSuperseded } = poolScope(opts);
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(requested, opts.scopeMode ?? 'additive', opts.ownScope),
    includeSuperseded: loadSuperseded,
    origin: opts.originProjects,
    admit: poolAdmits(opts),
  };
}

export async function searchPool(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  pool: RecallPool,
  profile: RecallProfile,
): Promise<SearchResult[]> {
  const scope = profile.scopeBoost === 'filter' ? opts.explicitScope : opts.activeScope;
  if (profile.scoreForm === 'engine') return engineSearch(ctx, opts, { pool, scope });
  // Every loaded row stays, in the order of an engine the request names; rows it leaves out keep
  // their load order.
  const ranked = opts.engineNamed ? await engineSearch(ctx, opts, { pool, scope }) : [];
  const order = withMissing(
    ranked.map((r) => r.entry),
    pool.local,
  );
  return order.map((entry, i) => ({
    entry,
    score: 1 - i / order.length,
    bm25: 0,
    cosine: 0,
    tokens: estimateTokens(entry.content),
  }));
}

async function engineSearch(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  poolSearch: PoolSearch,
): Promise<SearchResult[]> {
  const { pool, scope } = poolSearch;
  const { query, mmr, mmrLambda, explain } = opts;
  if (opts.graphStream) return graphStreamSearch(ctx, opts, opts.graphStream, poolSearch);
  if (opts.multihop) return multihopPoolSearch(ctx, opts, pool);
  const vectorCandidates = poolVectorCandidates(ctx, opts);
  const engine = engineOptions(ctx, opts);
  if (ctx.global && pool.global.length > 0) {
    // The pool already holds searchBothHybrid's additive-scope load for each store, so rank it
    // rather than read both stores again.
    return rankBothStores({
      query,
      sources: {
        local: vectorSourceOf(ctx),
        global: vectorSourceOf({ ...ctx.global, embedderFor: ctx.embedderFor }),
      },
      entries: { local: pool.local, global: pool.global },
      vectorCandidates,
      options: { ...engine, explain, scope, mmr, mmrLambda, localBump: opts.localBump },
    });
  }
  return rankHybrid(query, pool.local, {
    ...engine,
    source: vectorSourceOf(ctx),
    mmr,
    mmrLambda,
    explain,
    scope,
    vectorCandidates,
  });
}

/** `first`, then the rows of `second` that `first` does not hold. */
export function withMissing(first: MemoryEntry[], second: MemoryEntry[]): MemoryEntry[] {
  const held = new Set(first.map((e) => e.id));
  return [...first, ...second.filter((e) => !held.has(e.id))];
}
