// The `hippo-memory/search` entry's rankers. The caller's working folder and the eval switches in the environment are
// read here, at the entry, so the domain rankers take both as inputs.
import type { MemoryEntry } from '../base/memory/entry.js';
import type { SearchResult } from '../base/rank/search-types.js';
import { rankBm25, type SearchOptions } from '../domain/search/bm25-search.js';
import { rankMultihop } from '../domain/search/multihop.js';
import { withEvalSwitches } from './folder-search.js';

/** BM25 * strength * recency with the rank boosts; path tags come from `options.cwd`, else the process's folder. */
export function search(query: string, entries: MemoryEntry[], options: SearchOptions = {}): SearchResult[] {
  return rankBm25(query, entries, withEvalSwitches({ ...options, cwd: options.cwd ?? process.cwd() }));
}

/** Two BM25 passes, the second widened by the entities the first found; the working folder defaults as in search. */
export function multihopSearch(query: string, entries: MemoryEntry[], options: SearchOptions = {}): SearchResult[] {
  return rankMultihop(query, entries, withEvalSwitches({ ...options, cwd: options.cwd ?? process.cwd() }));
}

export { hybridSearch } from './folder-search.js';
export { explainMatch, MatchExplanation } from '../domain/search/explain.js';
export { detectTemporalDirection, temporalBoost, computeTemporalRange } from '../domain/search/temporal.js';
export { SearchResult } from '../base/rank/search-types.js';
export { graphExpandRecall, MAX_HOPS, DEFAULT_MAX_NEIGHBORS, type GraphExpandOpts } from '../domain/graph/recall.js';
