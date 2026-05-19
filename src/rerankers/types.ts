import type { SearchResult } from '../search.js';

/**
 * A reranker reorders (and optionally rescales) the candidate set produced
 * by hybridSearch's BM25 + cosine + MMR pipeline. Rerankers run AFTER MMR
 * de-duplication and BEFORE token-budget filtering, so the reranker sees
 * the full diversity-balanced candidate pool but does not see candidates
 * already filtered out by score-zero or supersession.
 *
 * Rerankers MUST be deterministic for a given (query, results) input
 * unless explicitly documented as stochastic (LLM track). Determinism is
 * required for paired A/B and for the workload-validity gate in
 * docs/evals/2026-05-10-f6-reranker-prereg.md.
 */
export type RerankerFn = (
  query: string,
  results: SearchResult[],
  options?: RerankerOptions,
) => Promise<RerankResult[]>;

export interface RerankerOptions {
  /** Cap candidates passed to the reranker. Default 50. */
  topK?: number;
  /** Per-track config blob; opaque to the seam. */
  config?: Record<string, unknown>;
}

export interface RerankResult extends SearchResult {
  /** Score assigned by the reranker. Replaces `score` for downstream
   *  ordering; original `score` preserved on the SearchResult. */
  rerankScore: number;
  /** 1-indexed rank in the input to the reranker. */
  preRerankRank: number;
  /** 1-indexed rank in the reranker output. */
  postRerankRank: number;
}

/**
 * Signals available to feature-based rerankers, extracted once per
 * candidate to avoid re-tokenizing or re-fetching.
 */
export interface RerankSignals {
  confidence: 'verified' | 'observed' | 'inferred' | 'stale' | null;
  schemaFit: number;
  kind: 'raw' | 'distilled' | 'superseded' | 'archived' | null;
  strength: number;
  retrievalCount: number;
  outcomePositive: number;
  outcomeNegative: number;
  emotionalValence: 'neutral' | 'error' | 'success' | 'critical' | null;
}
