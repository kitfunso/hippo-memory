import type { MemoryEntry } from './memory.js';

export const DEFAULT_RECALL_BUDGET = 4000;
// Local memories outrank global ones by this factor; getContext applies it as a 1/x global discount.
export const DEFAULT_LOCAL_BUMP = 1.2;

/** One score mutation applied after candidate generation; allocated only under `recall --why` or `RecallOpts.explain`. */
export interface RerankStep {
  /** One of: interference, value, utility, reranker, goal-boost, retrieval-count-downweight. */
  stage: string;
  /** The score multiplier applied at this stage, when the transform is a scalar multiply. */
  multiplier?: number;
  /** Score before this stage ran. */
  scoreBefore: number;
  /** Score after this stage ran. */
  scoreAfter: number;
  /** Optional human-readable detail (e.g. the matched goal tags). */
  note?: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;          // composite score
  bm25: number;
  cosine: number;         // cosine similarity (0 when embeddings not used)
  tokens: number;
  /** Populated when search is called with options.explain === true. */
  breakdown?: ScoreBreakdown;
  /** Ordered lifecycle re-ranking steps that mutated `score`; set only when `recall --why` asks for it. */
  rerankTrace?: RerankStep[];
  /** Set when a reranker ran; orders the results while `score` keeps the pre-rerank value. */
  rerankScore?: number;
  preRerankRank?: number;
  postRerankRank?: number;
  /** Set for results reached by graph traversal (`recall --hops N`): how the memory was reached from a lexical seed. */
  graphVia?: { hops: number; relType: string; direction: 'from' | 'to' };
}

/** What a result costs against a budget: the tokens of the text it prints as. */
export type ResultCost = (r: SearchResult) => number;

export interface ScoreBreakdown {
  /** `hybrid`: BM25 plus a cached doc vector; `hybrid-no-vec`: the query was embedded but this doc has no vector
   *  (run `hippo embed`); `bm25-only`: no usable embeddings; `physics`: scored by the physics engine. */
  mode: 'hybrid' | 'hybrid-no-vec' | 'bm25-only' | 'physics';
  /** BM25 score after normalization by max-in-corpus (0..1). */
  normBm25: number;
  /** Weight applied to BM25 in the hybrid blend. */
  bm25Weight: number;
  /** Weight applied to cosine in the hybrid blend. */
  embeddingWeight: number;
  /** Cosine similarity (0 when embeddings not used). */
  cosine: number;
  /** Blended base score before multipliers. */
  base: number;
  /** Multiplier from memory strength: 0.5 + 0.5*strength. */
  strengthMultiplier: number;
  /** Multiplier from age: 0.8 + 0.2*recencyBoost. */
  recencyMultiplier: number;
  /** 1.2 if tagged 'decision', else 1.0. */
  decisionBoost: number;
  /** 1.0..1.3 based on cwd path tag overlap. */
  pathBoost: number;
  /** 1.5 if scope matches, 0.5 if scope mismatches, 1.0 if neutral. */
  scopeBoost: number;
  /** Extra multiplier applied post-hybrid (e.g. 1.2x for local hits in a local+global merge); 1.0 otherwise. */
  sourceBump: number;
  /** Immediate outcome nudge, 1 + 0.15*tanh(pos - neg) clipped to [0.85, 1.15]; separate from the slow strength path. */
  outcomeBoost: number;
  /** CHURN_STALE_RANK_MULTIPLIER if tagged 'churn-stale', else 1.0. */
  churnStaleMultiplier: number;
  /** Pre-MMR rank (1-indexed). Only set when MMR re-ranking ran. */
  preMmrRank?: number;
  /** Post-MMR rank (1-indexed). Only set when MMR re-ranking ran. */
  postMmrRank?: number;
  /** Query terms that appeared verbatim in the doc. */
  matchedTerms: string[];
  /** Final composite score (= base * multipliers). */
  final: number;
  /** Age of the memory in whole days, at scoring time. */
  ageDays: number;
  /** entry.dag_level (0=raw, 1=extracted, 2=topic, 3=entity). */
  dagLevel?: number;
  /** descendant_count column, refreshed by the DAG rebuild. */
  descendantCount?: number;
  /** last_rebuilt_at ISO; null if never rebuilt. Summaries only. */
  lastRebuiltAt?: string | null;
  /** Cumulative rebuild_count. Summaries only. */
  rebuildCount?: number;
  /** Deboost applied (1.0 for non-summaries; default 0.85 for summaries). */
  summaryDeboost?: number;
  /** 1.05 if a summary was rebuilt within 7 days; 1.0 otherwise. */
  summaryFreshnessBoost?: number;
}
