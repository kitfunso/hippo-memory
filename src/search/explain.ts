import { tokenize } from '../util/tokenize.js';
import { matchedQueryTerms } from './bm25.js';
import type { SearchResult } from '../core/search-types.js';

const COSINE_DECIMALS = 3;

export interface MatchExplanation {
  /** Human-readable reason string */
  reason: string;
  /** Which query terms matched in the document (BM25 component) */
  matchedTerms: string[];
  /** Whether BM25 contributed to the score */
  hasBm25: boolean;
  /** Whether embedding similarity contributed to the score */
  hasEmbedding: boolean;
  /** Raw cosine similarity (0 when embeddings not used) */
  cosineSimilarity: number;
  /** Provenance envelope (kind, scope, owner, artifact_ref, session_id, confidence) */
  envelope?: {
    kind: string;
    scope: string | null;
    owner: string | null;
    artifact_ref: string | null;
    session_id: string | null;
    confidence: string;
  };
}

/** Why a result matched: the overlapping query terms and whether BM25 and/or embedding similarity contributed. */
export function explainMatch(query: string, result: SearchResult): MatchExplanation {
  const matchedTerms = matchedQueryTerms(new Set(tokenize(query)), result.entry);
  const hasBm25 = result.bm25 > 0;
  const hasEmbedding = result.cosine > 0;

  const parts: string[] = [];
  if (hasBm25) parts.push(`BM25: matched terms [${matchedTerms.join(', ')}]`);
  if (hasEmbedding) parts.push(`embedding similarity: ${result.cosine.toFixed(COSINE_DECIMALS)}`);
  if (parts.length === 0) parts.push('no direct term or embedding match');

  return {
    reason: parts.join('; '),
    matchedTerms,
    hasBm25,
    hasEmbedding,
    cosineSimilarity: result.cosine,
    envelope: {
      kind: result.entry.kind ?? 'distilled',
      scope: result.entry.scope ?? null,
      owner: result.entry.owner ?? null,
      artifact_ref: result.entry.artifact_ref ?? null,
      session_id: result.entry.source_session_id ?? null,
      confidence: result.entry.confidence ?? 'observed',
    },
  };
}
