import type { MemoryEntry } from '../memory.js';
import { tokenize } from '../tokenize.js';
import { evalNow } from '../ablation.js';
import { extractPathTags } from '../path-context.js';
import { detectScope } from '../scope.js';
import { compareScoredResults } from '../compare.js';
import type { RerankerFn, RerankerOptions } from '../rerankers/types.js';
import { bm25Score, buildCorpus, entryText, type BM25Corpus } from './bm25.js';
import { currentEntries } from './as-of.js';
import { summaryScoring, type BoostContext } from './boosts.js';
import { temporalContext } from './temporal.js';
import { denseScores, resolveVectorArm, type HybridVectorCandidates, type VectorArm } from './vector.js';
import { fuseRanks, type GraphStreamOptions } from './fusion.js';
import { scoreHybridPool } from './hybrid-score.js';
import { applyMmrWindow, applyReranker } from './rerank.js';
import { dedupeExtracted, fitBudget, withDagChildren } from './finalize.js';
import { DEFAULT_RECALL_BUDGET, type ResultCost, type SearchResult } from './types.js';

export interface HybridSearchOptions {
  budget?: number;
  now?: Date;
  hippoRoot?: string;
  embeddingWeight?: number;
  explain?: boolean;
  /** Disable MMR re-ranking even when embeddings are available. */
  mmr?: boolean;
  /** MMR balance: 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7. */
  mmrLambda?: number;
  /** 'blend' (weighted sum of BM25 and cosine, default) or 'rrf' (reciprocal rank fusion of their ranks). */
  scoring?: 'blend' | 'rrf';
  /** Corpus from `buildCorpus` over the same `entries` in the same order (content + tags), reused to skip tokenizing. */
  preparedCorpus?: BM25Corpus;
  /** Minimum number of results to return regardless of budget. Default 1. */
  minResults?: number;
  /** Budget cost per result; the caller that prints passes the cost of its printed text. */
  cost?: ResultCost;
  /** Active scope for scope-boost scoring. Auto-detected if not provided. */
  scope?: string | null;
  /** Include superseded memories in results. Default false. */
  includeSuperseded?: boolean;
  /** Filter to memories current at this ISO date string. */
  asOf?: string;
  /** Optional reranker. Runs after MMR, before budget filtering. See src/rerankers/types.ts. */
  reranker?: RerankerFn;
  /** Options passed through to the reranker. */
  rerankerOptions?: RerankerOptions;
  /** Multiplier on DAG summary scores. Default 0.85 (env HIPPO_SUMMARY_DEBOOST overrides; per-call wins). 1.0 disables. */
  summaryDeboost?: number;
  /** 1.05 micro-boost for summaries rebuilt within 7 days. Default true. */
  summaryFreshness?: boolean;
  /** Graph-proximity third RRF list; active only with `scoring: 'rrf'`, embeddings and a `hippoRoot`. See src/graph-stream.ts. */
  graphStream?: GraphStreamOptions;
  /** Add the rows nearest the query vector, not only rescore `entries`; without it a row no query word matches cannot surface. */
  vectorCandidates?: HybridVectorCandidates;
}

/** BM25 blended with cosine similarity when stored vectors and a provider are available, BM25 * strength * recency otherwise. */
export async function hybridSearch(query: string, entries: MemoryEntry[], options: HybridSearchOptions = {}): Promise<SearchResult[]> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const embeddingWeight = options.embeddingWeight ?? 0.6;
  const pool = currentEntries(entries, options);
  if (pool.length === 0) return [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const arm = await resolveVectorArm(query, pool, options);
  // A prepared corpus covers the caller's entries only, so rows the vector arm added force a rebuild.
  const corpus = (arm.addedRows ? undefined : options.preparedCorpus) ?? buildCorpus(arm.entries.map(entryText));
  const bm25Scores = arm.entries.map((_, i) => bm25Score(corpus, i, queryTerms));
  const dense = denseScores(arm);
  const fusion = { entries: arm.entries, bm25Scores, dense, bm25Weight: 1 - embeddingWeight, embeddingWeight };
  const rrfScores = arm.useEmbeddings && options.scoring === 'rrf'
    ? fuseRanks({ ...fusion, hippoRoot: options.hippoRoot, graphStream: options.graphStream })
    : null;

  const scored = scoreHybridPool({
    ...fusion,
    queryTerms,
    maxBm25: bm25Scores.reduce((a, b) => Math.max(a, b), 1e-9),
    useEmbeddings: arm.useEmbeddings,
    rrfScores,
    explain: options.explain ?? false,
    boosts: hybridBoostContext(query, arm.entries, now, options),
  });
  scored.sort(compareScoredResults);
  const ordered = await orderHybrid(query, withDagChildren(dedupeExtracted(scored), arm.entries), arm, options);
  return fitBudget(ordered, options.budget ?? DEFAULT_RECALL_BUDGET, options.minResults ?? 1, options.cost);
}

function hybridBoostContext(query: string, pool: MemoryEntry[], now: Date, options: HybridSearchOptions): BoostContext {
  return {
    now,
    pathTags: extractPathTags(process.cwd()),
    scope: options.scope !== undefined ? options.scope : detectScope(),
    temporal: temporalContext(query, pool),
    outcome: true,
    summary: summaryScoring(options),
  };
}

/** MMR when vectors are loaded, then the optional reranker. */
async function orderHybrid(query: string, scored: SearchResult[], arm: VectorArm, options: HybridSearchOptions): Promise<SearchResult[]> {
  const mmrLambda = options.mmrLambda ?? 0.7;
  const applyMmr = (options.mmr ?? true) && arm.useEmbeddings && scored.length > 1 && mmrLambda < 1;
  const ordered = applyMmr ? applyMmrWindow(scored, arm.embeddingIndex, mmrLambda, options.explain ?? false) : scored;
  return options.reranker ? applyReranker(query, ordered, options.reranker, options.rerankerOptions) : ordered;
}
