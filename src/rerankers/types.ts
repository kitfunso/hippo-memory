import type { SearchResult } from '../search.js';

/**
 * A reranker reorders (and optionally rescales) the candidate set produced
 * by hybridSearch's BM25 + cosine + MMR pipeline. Rerankers run AFTER MMR
 * de-duplication and BEFORE token-budget filtering, so the reranker sees
 * the full diversity-balanced candidate pool but does not see candidates
 * already filtered out by score-zero or supersession.
 *
 * Rerankers MUST be deterministic for a given (query, results) input
 * unless explicitly documented as stochastic (the LLM track, and the
 * hosted jev reranker, whose scores move slightly run to run).
 * Determinism is required for paired A/B and for the workload-validity
 * gate in docs/evals/2026-05-10-f6-reranker-prereg.md.
 *
 * @returns Reordered (and optionally rescaled) results.
 */
export type RerankerFn = (
  query: string,
  results: SearchResult[],
  options?: RerankerOptions,
) => Promise<RerankResult[]>;

/** JSON-serializable value. Per-track reranker config is opaque to the seam
 *  but must still be a concrete, serializable shape rather than `unknown`. */
export type RerankerConfigValue =
  | string
  | number
  | boolean
  | null
  | RerankerConfigValue[]
  | { [key: string]: RerankerConfigValue };

export interface RerankerOptions {
  /** Cap candidates passed to the reranker. Each reranker sets its own default. */
  topK?: number;
  /** Per-track config blob; opaque to the seam. */
  config?: Record<string, RerankerConfigValue>;
}

/** Which backend and model produced a rerank, or why it fell back. */
export interface RerankProvenance {
  /** `cloudflare`, `private-endpoint`, or `native` when the input order was kept. */
  backend: 'cloudflare' | 'private-endpoint' | 'native';
  /** Model the caller asked for. */
  requestedModel: string;
  /** Model the provider says scored the request, when it reports one. */
  actualModel?: string;
  /** Set when the input order was kept instead of a model ranking. */
  fallbackReason?: string;
  /** Provider-reported token usage, when sent. */
  inputTokens?: number;
  outputTokens?: number;
}

export interface RerankResult extends SearchResult {
  /** Score assigned by the reranker. Replaces `score` for downstream
   *  ordering; original `score` preserved on the SearchResult. */
  rerankScore: number;
  /** 1-indexed rank in the input to the reranker. */
  preRerankRank: number;
  /** 1-indexed rank in the reranker output. */
  postRerankRank: number;
  /** Recorded by rerankers that track model identity (the CLEF rerankers). */
  rerankProvenance?: RerankProvenance;
}
