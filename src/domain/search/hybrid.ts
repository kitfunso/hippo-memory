import { strengthOptionsOf, type MemoryEntry } from '../../base/memory/memory.js';
import type { EmbeddingsConfig, HippoConfig, RuntimeSettings } from '../../base/config/config.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import { tokenize } from '../../base/util/tokenize.js';
import { evalNow, rankAblation } from '../../base/memory/ablation.js';
import { pathTagsOf } from './path-context.js';
import { compareScoredResults } from '../../base/rank/compare.js';
import type { RerankerFn, RerankerOptions } from '../../base/ports/reranker.js';
import { bm25Score, buildCorpus, entryText, type BM25Corpus } from './bm25.js';
import { currentEntries } from './as-of.js';
import { summaryScoring, type BoostContext } from './boosts.js';
import { temporalContext } from './temporal.js';
import {
  denseScores,
  resolveVectorArm,
  type HybridVectorCandidates,
  type VectorArm,
  type VectorSource,
} from './vector.js';
import { fuseRanks, type FusionInput, type GraphStreamOptions } from './fusion.js';
import { scoreHybridPool } from './hybrid-score.js';
import { applyMmrWindow, applyReranker } from './rerank.js';
import { dedupeExtracted, fitBudget, withDagChildren } from './finalize.js';
import {
  DEFAULT_MMR_LAMBDA,
  DEFAULT_RECALL_BUDGET,
  type ResultCost,
  type SearchResult,
} from '../../base/rank/search-types.js';
import type { HippoStore } from '../../store/index.js';

/** How BM25 and cosine combine, and whether the score breakdown is kept. */
export interface HybridBlend {
  embeddingWeight?: number;
  /** 'blend' (weighted sum of BM25 and cosine, default) or 'rrf' (reciprocal rank fusion of their ranks). */
  scoring?: 'blend' | 'rrf';
  /**
   * Graph-proximity third RRF list; active only with `scoring: 'rrf'`, embeddings and a `hippoRoot` or `source`. See
   * src/domain/graph/stream.ts.
   */
  graphStream?: GraphStreamOptions;
  explain?: boolean;
}

/** The reordering after scoring: MMR, then the optional reranker. */
export interface HybridOrder {
  /** Disable MMR re-ranking even when embeddings are available. */
  mmr?: boolean;
  /** MMR balance: 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7. */
  mmrLambda?: number;
  /** Optional reranker. Runs after MMR, before budget filtering. See src/base/ports/reranker.ts. */
  reranker?: RerankerFn;
  /** Options passed through to the reranker. */
  rerankerOptions?: RerankerOptions;
}

/** The scope and summary boosts. */
export interface HybridBoosts {
  /** Active scope for scope-boost scoring; `runtime.activeScope` when not provided. */
  scope?: string | null;
  /**
   * Multiplier on DAG summary scores. Default 0.85 (`runtime.summaryDeboost` overrides; per-call wins). 1.0 disables.
   */
  summaryDeboost?: number;
  /** 1.05 micro-boost for summaries rebuilt within 7 days. Default true. */
  summaryFreshness?: boolean;
}

/** Which rows may rank. */
export interface HybridFilters {
  /** Include superseded memories in results. Default false. */
  includeSuperseded?: boolean;
  /** Filter to memories current at this ISO date string. */
  asOf?: string;
}

/** How many results come back and what each costs. */
export interface HybridBudget {
  budget?: number;
  /** Minimum number of results to return regardless of budget. Default 1. */
  minResults?: number;
  /** Budget cost per result; the caller that prints passes the cost of its printed text. */
  cost?: ResultCost;
}

/** What the caller already prepared: the corpus, the vector arm and its deadline. */
export interface HybridInputs {
  /**
   * Corpus from `buildCorpus` over the same `entries` in the same order (content + tags), reused to skip tokenizing.
   */
  preparedCorpus?: BM25Corpus;
  /**
   * Add the rows nearest the query vector, not only rescore `entries`; without it a row no query word matches cannot
   * surface.
   */
  vectorCandidates?: HybridVectorCandidates;
  /** Where vectors and the graph are read, in place of `hippoRoot`, `store` and `embeddings`. */
  source?: VectorSource;
  /** The deadline a caller already started for this recall's query embedding; a fresh budget when unset. */
  queryEmbedDeadline?: AbortSignal;
}

/** The clock and the root's environment settings. */
export interface HybridSettings {
  now?: Date;
  /** The root's environment settings: the scope, summary deboost and query-embedding budget a call names none of. */
  runtime?: RuntimeSettings;
  /** The folder the caller runs in: memories tagged with its path segments rank higher. Absent, no path boost. */
  cwd?: string;
}

/** The published wrapper's folder fields: hippo.db under `hippoRoot` when the caller names no store. */
export interface HybridFolder {
  hippoRoot?: string;
  /** The caller's embeddings config for `hippoRoot`; absent, its config.json is read. */
  embeddings?: EmbeddingsConfig;
  /** Where vectors are read; hippo.db under `hippoRoot` when unset. */
  store?: HippoStore;
}

/** Every ranking field, flat because the published hybridSearch and the frozen eval scripts pass them that way. */
type HybridRanking = HybridBlend &
  HybridOrder &
  HybridBoosts &
  HybridFilters &
  HybridBudget &
  HybridInputs &
  HybridSettings;

/** The published hybridSearch's options: the ranking fields and the folder it reads when it names no store. */
export type HybridSearchOptions = HybridRanking & HybridFolder;

/** hybridSearch's options once the caller names its stores; the folder fields belong to the published wrapper. */
export type HybridRankOptions = HybridRanking & {
  /** The global store the graph stream also walks; the published wrapper opens it from `graphStream.globalRoot`. */
  graphGlobal?: HippoStore;
};

// Share of the blended score that cosine takes.
export const DEFAULT_EMBEDDING_WEIGHT = 0.6;

/**
 * BM25 blended with cosine similarity when `source` holds vectors and a provider is available, BM25 * strength *
 * recency otherwise.
 */
export async function hybridSearch(
  query: string,
  entries: MemoryEntry[],
  options: HybridRankOptions = {},
): Promise<SearchResult[]> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const embeddingWeight = options.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT;
  const pool = currentEntries(entries, options);
  if (pool.length === 0) return [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const { source } = options;
  const arm = await resolveVectorArm(query, pool, source, options);
  // A prepared corpus covers the caller's entries only, so rows the vector arm added force a rebuild.
  const corpus = (arm.addedRows ? undefined : options.preparedCorpus) ?? buildCorpus(arm.entries.map(entryText));
  const bm25Scores = arm.entries.map((_, i) => bm25Score(corpus, i, queryTerms));
  const dense = denseScores(arm);
  const fusion = { entries: arm.entries, bm25Scores, dense, bm25Weight: 1 - embeddingWeight, embeddingWeight };
  const rrfScores =
    arm.useEmbeddings && options.scoring === 'rrf'
      ? await fuseRanks({ ...fusion, graph: graphStoresOf(source, options), graphStream: options.graphStream })
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

/** The vector arm over `store`, embedding queries with the provider `embedderFor` builds from `config`. */
export function vectorSourceOf({
  store,
  config,
  onHippoDb,
  embedderFor,
}: {
  store: HippoStore;
  config: Pick<HippoConfig, 'embeddings'>;
  onHippoDb?: boolean;
  embedderFor: EmbedderFor;
}): VectorSource {
  return { store, provider: () => embedderFor(config.embeddings), onHippoDb };
}

function graphStoresOf(source: VectorSource | undefined, options: HybridRankOptions): FusionInput['graph'] {
  return source && { store: source.store, global: options.graphGlobal };
}

function hybridBoostContext(query: string, pool: MemoryEntry[], now: Date, options: HybridRankOptions): BoostContext {
  return {
    now,
    pathTags: pathTagsOf(options.cwd),
    scope: options.scope !== undefined ? options.scope : (options.runtime?.activeScope ?? null),
    temporal: temporalContext(query, pool),
    outcome: true,
    summary: summaryScoring(options),
    strength: strengthOptionsOf(options.runtime),
    ablation: rankAblation(),
  };
}

/** MMR when vectors are loaded, then the optional reranker. */
async function orderHybrid(
  query: string,
  scored: SearchResult[],
  arm: VectorArm,
  options: HybridRankOptions,
): Promise<SearchResult[]> {
  const mmrLambda = options.mmrLambda ?? DEFAULT_MMR_LAMBDA;
  const applyMmr = (options.mmr ?? true) && arm.useEmbeddings && scored.length > 1 && mmrLambda < 1;
  const ordered = applyMmr ? applyMmrWindow(scored, arm.embeddingIndex, mmrLambda, options.explain ?? false) : scored;
  return options.reranker ? applyReranker(query, ordered, options.reranker, options.rerankerOptions) : ordered;
}
