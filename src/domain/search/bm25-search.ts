import { strengthOptionsOf, type MemoryEntry } from '../../base/memory/memory.js';
import type { RuntimeSettings } from '../../base/config/config.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { tokenize } from '../../base/util/tokenize.js';
import { evalNow, rankAblation } from '../../base/memory/ablation.js';
import { extractPathTags } from './path-context.js';
import { compareScoredResults } from '../../base/rank/compare.js';
import { bm25Score, buildCorpus, entryText } from './bm25.js';
import { currentEntries } from './as-of.js';
import { applyRankBoosts, strengthRecencyMultipliers, NO_SUMMARY_SCORING, type BoostContext } from './boosts.js';
import { temporalContext } from './temporal.js';
import { dedupeExtracted, fitBudget, withDagChildren } from './finalize.js';
import { DEFAULT_RECALL_BUDGET, type ResultCost, type SearchResult } from '../../base/rank/search-types.js';

export interface SearchOptions {
  budget?: number;
  now?: Date;
  hippoRoot?: string;
  minResults?: number;
  cost?: ResultCost;
  includeSuperseded?: boolean;
  asOf?: string;
  /** Active scope for scope-boost scoring; none when unset. */
  scope?: string | null;
  /** The root's settings; `lossAversionRatio` scales an error memory's strength. */
  runtime?: RuntimeSettings;
}

type Corpus = ReturnType<typeof buildCorpus>;

// Keyed on the caller's array so multihop's two passes share one build; the pool identity check keeps a mutated array
// honest.
const corpusCache = new WeakMap<MemoryEntry[], { pool: MemoryEntry[]; corpus: Corpus }>();

function corpusFor(entries: MemoryEntry[], pool: MemoryEntry[]): Corpus {
  const hit = corpusCache.get(entries);
  if (hit && hit.pool.length === pool.length && hit.pool.every((e, i) => e === pool[i])) return hit.corpus;
  const corpus = buildCorpus(pool.map(entryText));
  corpusCache.set(entries, { pool: pool.slice(), corpus });
  return corpus;
}

/**
 * Synchronous BM25 search: relevance * strength * recency and the rank boosts, without embeddings or the outcome nudge.
 */
export function search(query: string, entries: MemoryEntry[], options: SearchOptions = {}): SearchResult[] {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const pool = currentEntries(entries, options);
  if (pool.length === 0) return [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const corpus = corpusFor(entries, pool);
  const ctx: BoostContext = {
    now,
    pathTags: extractPathTags(process.cwd()),
    scope: options.scope ?? null,
    temporal: temporalContext(query, pool),
    outcome: false,
    summary: NO_SUMMARY_SCORING,
    strength: strengthOptionsOf(options.runtime),
    ablation: rankAblation(),
  };
  const scored: SearchResult[] = [];
  for (let i = 0; i < pool.length; i++) {
    const bm25 = bm25Score(corpus, i, queryTerms);
    if (bm25 <= 0) continue;
    const { strength, recency } = strengthRecencyMultipliers(pool[i], ctx);
    const normBm25 = bm25 / queryTerms.length;
    const score = applyRankBoosts(normBm25 * strength * recency, pool[i], ctx).score;
    scored.push({ entry: pool[i], score, bm25, cosine: 0, tokens: estimateTokens(pool[i].content) });
  }
  scored.sort(compareScoredResults);
  return fitBudget(
    withDagChildren(dedupeExtracted(scored), pool),
    options.budget ?? DEFAULT_RECALL_BUDGET,
    options.minResults ?? 1,
    options.cost,
  );
}
