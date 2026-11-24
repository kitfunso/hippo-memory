import { compareScoresDesc } from '../../base/rank/compare.js';
import { MemoryEntry } from '../../base/memory/entry.js';
import type { RuntimeSettings } from '../../base/config/config.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import {
  passesScopeFilterForRecall,
  passesCliRecallScopeFilter,
  recallScopeFilter,
} from '../../base/scope/recall-scope.js';
import { hybridSearch, vectorSourceOf } from '../search/hybrid.js';
import type { ConfiguredFolder } from '../../base/config/configured-folder.js';
import { fitBudget } from '../search/finalize.js';
import {
  DEFAULT_LOCAL_BUMP,
  DEFAULT_RECALL_BUDGET,
  type RankTime,
  type SearchResult,
  type ResultCost,
} from '../../base/rank/search-types.js';
import {
  startQueryEmbedDeadline,
  type HybridVectorCandidates,
  type VectorSource,
} from '../search/vector.js';
import type { EvalSwitches } from '../../base/memory/eval-switches.js';
import { duplicateKey, identityText } from '../../base/util/same-text.js';
import type { TenantId } from '../../base/util/tenant.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { SharingStore } from './text-keys.js';

const FILTERED_SEARCH_WINDOW = 5000;

export function logEmbedAllFailure<E>(caller: string, err: E): void {
  log.warn(
    `${caller}: background embed failed (${errorMessage(err)}); run 'hippo embed' to backfill`,
    errorFields(err),
  );
}

export interface SearchOptions {
  budget?: number;
  now?: Date;
  minResults?: number;
}

export interface HybridSearchOptions extends SearchOptions {
  embeddingWeight?: number;
  explain?: boolean;
  mmr?: boolean;
  mmrLambda?: number;
  localBump?: number;
  scope?: string | null;
  runtime?: RuntimeSettings;
  cwd?: string;
  switches?: EvalSwitches;
  includeSuperseded?: boolean;
  asOf?: string;
  cost?: ResultCost;
  summaryDeboost?: number;
  summaryFreshness?: boolean;
  entryFilter?: (entry: MemoryEntry) => boolean;
  recallScope?: { requested?: string; additive?: boolean; ownScope?: string };
}

/** `HybridSearchOptions` with the tenant both stores are read as (the eval harness reads every
 * tenant's) and the embedder each store's vector arm uses. */
export type BothStoresSearch = HybridSearchOptions &
  RankTime & { readonly tenantId: TenantId; readonly embedderFor: EmbedderFor };

/** Hybrid search across both local and global stores, using embeddings when available.
 *  Each store ranks through hybridSearch, then the local bump, one copy per text and the shared budget apply. */
export async function searchBothHybrid(
  query: string,
  local: ConfiguredFolder<SharingStore>,
  global: ConfiguredFolder<SharingStore>,
  options: BothStoresSearch,
): Promise<SearchResult[]> {
  const { embedderFor } = options;
  const admit = scopeAdmission(options);
  const loaded = await Promise.all([
    loadStoreEntries(query, local.store, options),
    loadStoreEntries(query, global.store, options),
  ]);
  const [localEntries, globalEntries] = loaded.map((entries) => entries.filter(admit));
  const sources = {
    local: folderVectorSource(local, embedderFor),
    global: folderVectorSource(global, embedderFor),
  };
  return rankBothStores({
    query,
    sources,
    entries: { local: localEntries, global: globalEntries },
    vectorCandidates: recallVectorCandidates(options, admit),
    options,
  });
}

async function loadStoreEntries(
  query: string,
  store: SharingStore,
  options: BothStoresSearch,
): Promise<MemoryEntry[]> {
  const { includeSuperseded, asOf, tenantId, entryFilter, recallScope } = options;
  const searchWindow = entryFilter ? FILTERED_SEARCH_WINDOW : undefined;
  const { sharing } = store;
  if (!(await store.folderFiles.home()).exists) return [];
  return recallScope
    ? sharing.recallEntries(query, {
        limit: searchWindow,
        tenantId,
        requestedScope: recallScope.requested,
        explicitScopeMode: recallScope.additive ? 'additive' : 'exact',
        includeSuperseded: Boolean(includeSuperseded) || Boolean(asOf),
        ownScope: recallScope.ownScope,
      })
    : sharing.searchEntries(query, searchWindow, tenantId);
}

function scopeAdmission(options: BothStoresSearch): (e: MemoryEntry) => boolean {
  const { entryFilter, recallScope } = options;
  const passesScope = (e: MemoryEntry): boolean =>
    !recallScope ||
    (recallScope.additive
      ? passesCliRecallScopeFilter(e.scope ?? null, recallScope.requested) ||
        passesScopeFilterForRecall(e.scope ?? null, undefined, recallScope.ownScope)
      : passesScopeFilterForRecall(e.scope ?? null, recallScope.requested, recallScope.ownScope));
  return (e: MemoryEntry): boolean => passesScope(e) && (!entryFilter || entryFilter(e));
}

function recallVectorCandidates(
  options: BothStoresSearch,
  admit: (e: MemoryEntry) => boolean,
): HybridVectorCandidates {
  const { includeSuperseded, asOf, tenantId, recallScope } = options;
  return {
    tenantId,
    scope: recallScope
      ? recallScopeFilter(
          recallScope.requested,
          recallScope.additive ? 'additive' : 'exact',
          recallScope.ownScope,
        )
      : undefined,
    includeSuperseded: !recallScope || Boolean(includeSuperseded) || Boolean(asOf),
    admit,
  };
}

function folderVectorSource(
  { store, config }: ConfiguredFolder<SharingStore>,
  embedderFor: EmbedderFor,
): VectorSource | undefined {
  return vectorSourceOf({ store, config, onHippoDb: true, embedderFor });
}

function pricedAs(cost: ResultCost | undefined, isGlobal: boolean): ResultCost | undefined {
  return cost && ((r) => cost({ ...r, isGlobal }));
}

function mergeStoreResults(
  localResults: SearchResult[],
  globalResults: SearchResult[],
  localBump: number,
): Array<SearchResult & { isGlobal: boolean }> {
  const tagged: Array<SearchResult & { isGlobal: boolean }> = [
    ...localResults.map((r) => ({
      ...r,
      isGlobal: false,
      score: r.score * localBump,
      breakdown: r.breakdown
        ? { ...r.breakdown, sourceBump: localBump, final: r.breakdown.final * localBump }
        : undefined,
    })),
    ...globalResults.map((r) => ({ ...r, isGlobal: true })),
  ];

  const seen = new Set<string>();
  const deduped = tagged.filter((r) => {
    const key = duplicateKey(identityText(r.entry));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => compareScoresDesc(a.score, b.score));
  return deduped;
}

export interface RankBothStoresOptions {
  readonly query: string;
  readonly sources: { local: VectorSource | undefined; global: VectorSource | undefined };
  readonly entries: { local: MemoryEntry[]; global: MemoryEntry[] };
  readonly vectorCandidates: HybridVectorCandidates;
  readonly options: HybridSearchOptions & RankTime;
}

/** Hybrid ranking of rows already loaded from each store: the local bump, one copy per text,
 * then the shared budget. */
export async function rankBothStores({
  query,
  sources,
  entries,
  vectorCandidates,
  options,
}: RankBothStoresOptions): Promise<SearchResult[]> {
  const {
    budget = DEFAULT_RECALL_BUDGET,
    localBump = DEFAULT_LOCAL_BUMP,
    minResults,
    cost,
  } = options;
  if (entries.local.length === 0 && entries.global.length === 0) return [];
  const shared = sharedRanking(options, vectorCandidates);
  const side = (isGlobal: boolean) => ({ ...shared, cost: pricedAs(cost, isGlobal) });
  const localResults = await hybridSearch(query, entries.local, {
    ...side(false),
    source: sources.local,
  });
  const globalResults = await hybridSearch(query, entries.global, {
    ...side(true),
    source: sources.global,
  });
  return fitBudget(
    mergeStoreResults(localResults, globalResults, localBump),
    budget,
    minResults,
    cost,
  );
}

function sharedRanking(
  options: HybridSearchOptions & RankTime,
  vectorCandidates: HybridVectorCandidates,
) {
  const {
    budget = DEFAULT_RECALL_BUDGET,
    switches,
    embeddingWeight,
    explain,
    mmr,
    mmrLambda,
    minResults,
    scope,
    includeSuperseded,
    asOf,
    summaryDeboost,
    summaryFreshness,
  } = options;
  return {
    budget,
    now: options.now,
    switches,
    embeddingWeight,
    explain,
    mmr,
    mmrLambda,
    minResults,
    scope,
    includeSuperseded,
    asOf,
    summaryDeboost,
    summaryFreshness,
    runtime: options.runtime,
    cwd: options.cwd,
    vectorCandidates,
    queryEmbedDeadline: startQueryEmbedDeadline(options),
  };
}
