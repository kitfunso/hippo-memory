import type { SearchResult } from '../core/search-types.js';

/** Reorders hybridSearch's candidates AFTER MMR de-duplication and BEFORE token-budget filtering, so it sees the full diverse pool.
 * MUST be deterministic for a given (query, results) unless documented stochastic (LLM track, hosted jev): paired A/B and the validity gate need it. */
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
