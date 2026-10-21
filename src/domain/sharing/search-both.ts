// Search across the local and global stores, merged into one ranked, budgeted list.

import { compareScoresDesc } from '../../base/rank/compare.js';
import { MemoryEntry } from '../../base/memory/memory.js';
import type { RuntimeSettings } from '../../base/config/config.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import {
  passesScopeFilterForRecall,
  passesCliRecallScopeFilter,
  recallScopeFilter,
} from '../../base/scope/recall-scope.js';
import { hybridSearch, vectorSourceOf } from '../search/hybrid.js';
import type { ConfiguredFolder } from '../search/embed-memories.js';
import { fitBudget } from '../search/finalize.js';
import {
  DEFAULT_LOCAL_BUMP,
  DEFAULT_RECALL_BUDGET,
  type SearchResult,
  type ResultCost,
} from '../../base/rank/search-types.js';
import { startQueryEmbedDeadline, type HybridVectorCandidates, type VectorSource } from '../search/vector.js';
import { evalNow } from '../../base/memory/ablation.js';
import { duplicateKey } from '../../base/util/same-text.js';
import type { TenantId } from '../../base/util/tenant.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { SharingStore } from './text-keys.js';

// The rows are already copied; a failed background embed only delays vectors, so it warns instead of throwing.
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
  /** Multiplier applied to local-store scores when merging with global.
   *  Defaults to 1.2. Use 1.0 to remove the local bias for eval comparisons. */
  localBump?: number;
  /** Active scope for scope-boost scoring; `runtime.activeScope` when not provided. */
  scope?: string | null;
  /** The root's environment settings: scope, summary deboost and query-embedding budget, when the call sets none. */
  runtime?: RuntimeSettings;
  /** Include superseded memories in results. Default false. */
  includeSuperseded?: boolean;
  /** Filter to memories current at this ISO date string. */
  asOf?: string;
  /** Budget cost per result, spent the same way in each store and in the merged list. */
  cost?: ResultCost;
  /** Propagated to underlying hybridSearch calls.
   *  Per-call > the root's HIPPO_SUMMARY_DEBOOST > 0.85 default. */
  summaryDeboost?: number;
  /** Propagated. Default true (1.05 boost if rebuilt within 7d). */
  summaryFreshness?: boolean;
  /** Optional admission predicate applied to the loaded candidates of BOTH stores before ranking, cross-store dedupe
   * and budgeting, so an excluded row cannot shadow its admitted duplicate or saturate the budget. Undefined (recall
   * paths never set it) means no filter. */
  entryFilter?: (entry: MemoryEntry) => boolean;
  /** Recall scope filter for `searchBothHybrid`: absent is the only unfiltered mode; present uses
   * `loadRecallSearchEntries` plus a JS post-filter.
   * `{}` = default-deny (legacy and `<source>:private:*` excluded); `{ requested: 'X' }` = exact; `{ requested: 'X',
   * additive: true }` = default plus X.
   * An object, not `string | null`, because the sibling `scope` option already gives null a different meaning.
   * Do not pass `{}` casually from non-recall paths. */
  recallScope?: { requested?: string; additive?: boolean; ownScope?: string };
}

/** `HybridSearchOptions` with the tenant both stores are read as (the eval harness reads every tenant's) and the
 * embedder each store's vector arm uses. */
export type BothStoresSearch = HybridSearchOptions & { readonly tenantId: TenantId; readonly embedderFor: EmbedderFor };

/** Hybrid search across both local and global stores, using embeddings when available.
 *  Each store ranks through hybridSearch, then the local bump, one copy per text and the shared budget apply. */
export async function searchBothHybrid(
  query: string,
  local: ConfiguredFolder<SharingStore>,
  global: ConfiguredFolder<SharingStore>,
  options: BothStoresSearch,
): Promise<SearchResult[]> {
  const { includeSuperseded, asOf, tenantId, entryFilter, recallScope, embedderFor } = options;

  // With an admission filter, lift the per-store candidate cap (default 200) to a bounded 5000: excluded rows could
  // otherwise fill the window first.
  const searchWindow = entryFilter ? 5000 : undefined;
  // Recall mode: push the scope predicate into SQL like api.recall, so quarantine/private rows never enter the
  // candidates, shadow duplicates or use budget.
  // The JS post-filter below is the regex-only `<source>:private:*` half plus defense in depth on exact match.
  const loadEntries = async ({ store }: { readonly store: SharingStore }): Promise<MemoryEntry[]> => {
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
  };
  const passesScope = (e: MemoryEntry): boolean =>
    !recallScope ||
    (recallScope.additive
      ? passesCliRecallScopeFilter(e.scope ?? null, recallScope.requested) ||
        passesScopeFilterForRecall(e.scope ?? null, undefined, recallScope.ownScope)
      : passesScopeFilterForRecall(e.scope ?? null, recallScope.requested, recallScope.ownScope));
  const admit = (e: MemoryEntry): boolean => passesScope(e) && (!entryFilter || entryFilter(e));
  const localEntries = (await loadEntries(local)).filter(admit);
  const globalEntries = (await loadEntries(global)).filter(admit);

  // The vector arm loads under the same SQL rules as loadEntries, then the same JS admission.
  const vectorCandidates: HybridVectorCandidates = {
    tenantId,
    scope: recallScope
      ? recallScopeFilter(recallScope.requested, recallScope.additive ? 'additive' : 'exact', recallScope.ownScope)
      : undefined,
    includeSuperseded: !recallScope || Boolean(includeSuperseded) || Boolean(asOf),
    admit,
  };
  const sources = { local: folderVectorSource(local, embedderFor), global: folderVectorSource(global, embedderFor) };
  return rankBothStores(query, sources, { local: localEntries, global: globalEntries }, vectorCandidates, options);
}

/** The store's own vectors, with the embedding provider its folder's config names. */
function folderVectorSource({ store, config }: ConfiguredFolder, embedderFor: EmbedderFor): VectorSource {
  return vectorSourceOf({ store, config, onHippoDb: true, embedderFor });
}

/** Each store prices its rows already tagged, so a price that reads the store origin sees it before the merge. */
function pricedAs(cost: ResultCost | undefined, isGlobal: boolean): ResultCost | undefined {
  return cost && ((r) => cost({ ...r, isGlobal }));
}

function mergeStoreResults(
  localResults: SearchResult[],
  globalResults: SearchResult[],
  localBump: number,
): Array<SearchResult & { isGlobal: boolean }> {
  // Tag global results. Local memories get a configurable priority bump.
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

  // Remove duplicates by content (local/global IDs differ after promote/share)
  const seen = new Set<string>();
  const deduped = tagged.filter((r) => {
    const key = duplicateKey(r.entry.content);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // PLAIN stable score sort on purpose: both inputs are deterministically ordered, and an exact tie keeps the LOCAL
  // result ahead of the global one (concat order).
  deduped.sort((a, b) => compareScoresDesc(a.score, b.score));
  return deduped;
}

/** Hybrid ranking of rows already loaded from each store: the local bump, one copy per text, then the shared budget. */
export async function rankBothStores(
  query: string,
  sources: { local: VectorSource | undefined; global: VectorSource | undefined },
  entries: { local: MemoryEntry[]; global: MemoryEntry[] },
  vectorCandidates: HybridVectorCandidates,
  options: HybridSearchOptions = {},
): Promise<SearchResult[]> {
  const {
    budget = DEFAULT_RECALL_BUDGET,
    now = evalNow(),
    embeddingWeight,
    explain,
    mmr,
    mmrLambda,
    localBump = DEFAULT_LOCAL_BUMP,
    minResults,
    cost,
    scope,
    includeSuperseded,
    asOf,
    summaryDeboost,
    summaryFreshness,
  } = options;
  if (entries.local.length === 0 && entries.global.length === 0) return [];
  // One deadline for both stores, so a provider that stalls on the first is not waited on again for the second.
  const shared = {
    budget,
    now,
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
    vectorCandidates,
    queryEmbedDeadline: startQueryEmbedDeadline(options.runtime?.queryEmbedTimeoutMs),
  };
  const side = (isGlobal: boolean) => ({ ...shared, cost: pricedAs(cost, isGlobal) });
  const localResults = await hybridSearch(query, entries.local, { ...side(false), source: sources.local });
  const globalResults = await hybridSearch(query, entries.global, { ...side(true), source: sources.global });

  const deduped = mergeStoreResults(localResults, globalResults, localBump);

  return fitBudget(deduped, budget, minResults ?? 1, cost);
}
