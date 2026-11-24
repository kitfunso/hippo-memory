import type { SearchResult } from '../rank/search-types.js';
import type { ClefSettings } from '../config/config.js';

/**
 * Reorders hybridSearch's candidates AFTER MMR de-duplication and BEFORE token-budget filtering, so
 * it sees the full diverse pool. MUST be deterministic for a given (query, results) unless
 * documented stochastic (LLM track, hosted jev): paired A/B and the validity gate need it.
 */
export type RerankerFn = (
  query: string,
  results: SearchResult[],
  options?: RerankerOptions,
) => Promise<RerankResult[]>;

/** A named reranker, or null for no name; an unknown name throws with the names there are. */
export type RerankerLookup = (name: string | null | undefined) => RerankerFn | null;

/** JSON-serializable value. Per-track reranker config is opaque to the seam but must still be a concrete, serializable
 *  shape rather than `unknown`. */
export type RerankerConfigValue =
  | string
  | number
  | boolean
  | null
  | RerankerConfigValue[]
  | { [key: string]: RerankerConfigValue };

export interface RerankerOptions {
  topK?: number;
  config?: Record<string, RerankerConfigValue>;
  clef?: ClefSettings;
  signal?: AbortSignal;
}

/** Which backend and model produced a rerank, or why it fell back. */
export interface RerankProvenance {
  backend: 'cloudflare' | 'private-endpoint' | 'native';
  requestedModel: string;
  actualModel?: string;
  fallbackReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface RerankResult extends SearchResult {
  rerankScore: number;
  preRerankRank: number;
  postRerankRank: number;
  rerankProvenance?: RerankProvenance;
}
