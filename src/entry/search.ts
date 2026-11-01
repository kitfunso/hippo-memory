// The `hippo-memory/search` entry's rankers. The caller's working folder and the eval switches in
// the environment are read here, at the entry, so the domain rankers take both as inputs.
import type { MemoryEntry } from '../base/memory/entry.js';
import type { SearchResult } from '../base/rank/search-types.js';
import { rankBm25, type Bm25SearchOptions } from '../domain/search/bm25-search.js';
import { rankMultihop } from '../domain/search/multihop.js';
import { withEvalSwitches } from './folder-search.js';
import type { HippoStore } from '../base/ports/store.js';
import { coreEnrichment, globalEnrichment } from '../api/hippo-db-context.js';
import {
  expandOnGraphs,
  graphOf,
  type GraphExpandOptions as GraphWalkOptions,
} from '../domain/graph/recall.js';

/** BM25 * strength * recency with the rank boosts; path tags come from `options.cwd`, else the
 * process's folder. */
export function search(
  query: string,
  entries: MemoryEntry[],
  options: Bm25SearchOptions = {},
): SearchResult[] {
  return rankBm25(
    query,
    entries,
    withEvalSwitches({ ...options, cwd: options.cwd ?? process.cwd() }),
  );
}

/** Two BM25 passes, the second widened by the entities the first found; the working folder
 * defaults as in search. */
export function multihopSearch(
  query: string,
  entries: MemoryEntry[],
  options: Bm25SearchOptions = {},
): SearchResult[] {
  return rankMultihop(
    query,
    entries,
    withEvalSwitches({ ...options, cwd: options.cwd ?? process.cwd() }),
  );
}

export { hybridSearch } from './folder-search.js';
export { explainMatch, MatchExplanation } from '../domain/search/explain.js';
export {
  detectTemporalDirection,
  temporalBoost,
  computeTemporalRange,
} from '../domain/search/temporal.js';
export { SearchResult } from '../base/rank/search-types.js';
export { MAX_HOPS, DEFAULT_MAX_NEIGHBORS } from '../domain/graph/recall.js';

/** graphExpandRecall's options: `store` and `global` are stores, and the walk reads the graph
 * each keeps on hippo.db's local tier. */
export type GraphExpandOptions = Omit<GraphWalkOptions, 'store' | 'global'> & {
  store: HippoStore;
  global?: HippoStore;
};

/** Multi-hop graph recall from `results` over `store` and `global`; a store that keeps no graph
 * adds no neighbours. */
export async function graphExpandRecall(
  results: SearchResult[],
  opts: GraphExpandOptions,
): Promise<SearchResult[]> {
  const store = graphOf(opts.store, coreEnrichment(opts.store)?.graph);
  if (store === undefined) return results;
  const global = opts.global && graphOf(opts.global, globalEnrichment(opts.global)?.graph);
  return expandOnGraphs(results, { ...opts, store, global });
}
