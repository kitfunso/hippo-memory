import type { MemoryEntry } from '../memory.js';
import { estimateTokens } from '../util/token-text.js';
import { tokenize } from '../tokenize.js';
import { evalNow } from '../ablation.js';
import { extractPathTags } from '../path-context.js';
import { detectScope } from '../scope.js';
import { compareScoredResults } from '../compare.js';
import { bm25Score, buildCorpus, entryText } from './bm25.js';
import { currentEntries } from './as-of.js';
import { applyRankBoosts, strengthRecencyMultipliers, NO_SUMMARY_SCORING, type BoostContext } from './boosts.js';
import { temporalContext } from './temporal.js';
import { dedupeExtracted, fitBudget, withDagChildren } from './finalize.js';
import { DEFAULT_RECALL_BUDGET, type ResultCost, type SearchResult } from '../core/search-types.js';

export interface SearchOptions {
  budget?: number;
  now?: Date;
  hippoRoot?: string;
  minResults?: number;
  cost?: ResultCost;
  includeSuperseded?: boolean;
  asOf?: string;
}

/** Synchronous BM25 search: relevance * strength * recency and the rank boosts, without embeddings or the outcome nudge. */
export function search(query: string, entries: MemoryEntry[], options: SearchOptions = {}): SearchResult[] {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const pool = currentEntries(entries, options);
  if (pool.length === 0) return [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const corpus = buildCorpus(pool.map(entryText));
  const ctx: BoostContext = {
    now,
    pathTags: extractPathTags(process.cwd()),
    scope: detectScope(),
    temporal: temporalContext(query, pool),
    outcome: false,
    summary: NO_SUMMARY_SCORING,
  };
  const scored: SearchResult[] = [];
  for (let i = 0; i < pool.length; i++) {
    const bm25 = bm25Score(corpus, i, queryTerms);
    if (bm25 <= 0) continue;
    const { strength, recency } = strengthRecencyMultipliers(pool[i], now);
    const normBm25 = bm25 / queryTerms.length;
    const score = applyRankBoosts(normBm25 * strength * recency, pool[i], ctx).score;
    scored.push({ entry: pool[i], score, bm25, cosine: 0, tokens: estimateTokens(pool[i].content) });
  }
  scored.sort(compareScoredResults);
  return fitBudget(withDagChildren(dedupeExtracted(scored), pool), options.budget ?? DEFAULT_RECALL_BUDGET, options.minResults ?? 1, options.cost);
}
