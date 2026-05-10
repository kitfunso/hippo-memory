import { tokenize } from '../search.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

const CONFIDENCE_WEIGHT: Record<string, number> = {
  verified: 1.30,
  observed: 1.10,
  inferred: 0.90,
  stale: 0.70,
};

const KIND_WEIGHT: Record<string, number> = {
  distilled: 1.10,
  raw: 1.00,
  superseded: 0.50,
  archived: 0.30,
};

/**
 * Track 1 reranker: rescore the candidate set using signals already on
 * MemoryEntry. No external dependencies, no network, no model load.
 *
 * Score = base_score * confidence_w * kind_w * (0.7 + 0.3*schema_fit)
 *       * (0.8 + 0.2*tanh(strength)) * (1 + 0.1*tanh(pos-neg))
 *       * exact_overlap_boost
 *
 * Weights are calibrated for sign and order, NOT a magnitude claim.
 * See docs/plans/2026-05-10-f6-reranker-hardening.md Task 3.
 */
export const featuresReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const topK = options?.topK ?? 50;
  const head = results.slice(0, topK);
  const queryTerms = new Set(tokenize(query));

  const rescored = head.map((r, i) => {
    const e = r.entry;

    const confW = CONFIDENCE_WEIGHT[e.confidence ?? ''] ?? 1.0;
    const kindW = KIND_WEIGHT[e.kind ?? ''] ?? 1.0;
    const schemaFitW = 0.7 + 0.3 * (e.schema_fit ?? 0.5);
    const strengthW = 0.8 + 0.2 * Math.tanh(e.strength ?? 0);

    const pos = e.outcome_positive ?? 0;
    const neg = e.outcome_negative ?? 0;
    const outcomeW = 1 + 0.1 * Math.tanh((pos - neg) / 2);

    const docTerms = new Set(tokenize(`${e.content} ${e.tags.join(' ')}`));
    let overlap = 0;
    for (const t of queryTerms) if (docTerms.has(t)) overlap++;
    const overlapW = queryTerms.size > 0 ? 1 + 0.2 * (overlap / queryTerms.size) : 1;

    const rerankScore = r.score * confW * kindW * schemaFitW * strengthW * outcomeW * overlapW;

    return {
      ...r,
      rerankScore,
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: 0,
    };
  });

  rescored.sort((a, b) => b.rerankScore - a.rerankScore);
  rescored.forEach((r, i) => (r.postRerankRank = i + 1));

  return rescored;
};
