import type { MemoryEntry } from '../memory/entry.js';

/** Default candidate-pool size for `listSearchEntries` when `limit` is undefined; `api.recall`
 * imports it for `RecallResult.windowSize` so the two cannot drift. */
export const DEFAULT_SEARCH_CANDIDATE_LIMIT = 200;

export const DEFAULT_RECALL_BUDGET = 4000;

/** Results a search keeps whatever they cost when the caller names no minimum. */
export const DEFAULT_MIN_RESULTS = 1;
export const DEFAULT_LOCAL_BUMP = 1.2;
export const DEFAULT_MMR_LAMBDA = 0.7;
export const CONFLICT_PEER_MULTIPLIER = 0.3;
export const VALUE_MULT_SLOPE = 0.3;
export const VALUE_MULT_MIN = 0.7;
export const VALUE_MULT_MAX = 1.3;
export const UTILITY_LENGTH_PENALTY_CAP = 0.3;
export const UTILITY_LENGTH_TOKENS = 10000;
export const SALIENCE_MIN_MULTIPLIER = 0.5;

/**
 * One score mutation applied after candidate generation; allocated only under `recall --why` or
 * `RecallOptions.trace.explain`.
 */
export interface RerankStep {
  stage: string;
  multiplier?: number;
  scoreBefore: number;
  scoreAfter: number;
  note?: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number; // composite score
  bm25: number;
  cosine: number; // cosine similarity (0 when embeddings not used)
  tokens: number;
  /** Populated when search is called with options.explain === true. */
  breakdown?: ScoreBreakdown;
  /** Ordered lifecycle re-ranking steps that mutated `score`; set only when `recall --why` asks
   * for it. */
  rerankTrace?: RerankStep[];
  /** Set when a reranker ran; orders the results while `score` keeps the pre-rerank value. */
  rerankScore?: number;
  preRerankRank?: number;
  postRerankRank?: number;
  /** Set for results reached by graph traversal (`recall --hops N`): how the memory was reached
   * from a lexical seed. */
  graphVia?: { hops: number; relType: string; direction: 'from' | 'to' };
  /** Set where a recall merges the local and global stores: true when the row came from the
   * global one. */
  isGlobal?: boolean;
}

/** What a result costs against a budget: the tokens of the text it prints as. */
export type ResultCost = (r: SearchResult) => number;

export interface ScoreBreakdown {
  mode: 'hybrid' | 'hybrid-no-vec' | 'bm25-only' | 'physics';
  normBm25: number;
  bm25Weight: number;
  embeddingWeight: number;
  cosine: number;
  base: number;
  strengthMultiplier: number;
  recencyMultiplier: number;
  decisionBoost: number;
  pathBoost: number;
  scopeBoost: number;
  sourceBump: number;
  outcomeBoost: number;
  churnStaleMultiplier: number;
  preMmrRank?: number;
  postMmrRank?: number;
  matchedTerms: string[];
  final: number;
  ageDays: number;
  dagLevel?: number;
  descendantCount?: number;
  lastRebuiltAt?: string | null;
  rebuildCount?: number;
  summaryDeboost?: number;
  summaryFreshnessBoost?: number;
}

/** The instant a ranking scores at: its caller reads it from the clock its root gave it. */
export interface RankTime {
  readonly now: Date;
}

/** The instant a ranking scores at: the caller's, else the wall clock, kept for frozen dist scripts that
 *  pass no `now`. */
export function rankNow(time: Partial<RankTime>): Date {
  return time.now ?? new Date();
}
