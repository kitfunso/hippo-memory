import type { MemoryEntry } from '../memory.js';
import { estimateTokens } from '../token-ledger.js';
import { matchedQueryTerms } from './bm25.js';
import { applyRankBoosts, strengthRecencyMultipliers, type AppliedBoosts, type BoostContext } from './boosts.js';
import { addDagFields, ageInDays } from './breakdown.js';
import type { DenseScores } from './vector.js';
import type { ScoreBreakdown, SearchResult } from '../core/search-types.js';

type HybridMode = 'hybrid' | 'hybrid-no-vec' | 'bm25-only';

export interface HybridScoreInput {
  entries: MemoryEntry[];
  queryTerms: string[];
  bm25Scores: number[];
  maxBm25: number;
  dense: DenseScores;
  useEmbeddings: boolean;
  rrfScores: Map<number, number> | null;
  bm25Weight: number;
  embeddingWeight: number;
  explain: boolean;
  boosts: BoostContext;
}

interface EntryScore {
  base: number;
  mode: HybridMode;
  normBm25: number;
  strength: number;
  recency: number;
  boosts: AppliedBoosts;
}

/** Scores every pool entry; rows with no lexical hit drop out unless vectors are in play, and non-positive scores always do. */
export function scoreHybridPool(input: HybridScoreInput): SearchResult[] {
  const scored: SearchResult[] = [];
  const queryTermSet = new Set(input.queryTerms);
  for (let i = 0; i < input.entries.length; i++) {
    if (!input.useEmbeddings && input.bm25Scores[i] <= 0) continue;
    const s = scoreEntry(i, input);
    if (s.boosts.score <= 0) continue;
    const entry = input.entries[i];
    const result: SearchResult = {
      entry,
      score: s.boosts.score,
      bm25: input.bm25Scores[i],
      cosine: input.dense.cosine[i],
      tokens: estimateTokens(entry.content),
    };
    if (input.explain) result.breakdown = hybridBreakdown(i, s, input, queryTermSet);
    scored.push(result);
  }
  return scored;
}

function scoreEntry(i: number, input: HybridScoreInput): EntryScore {
  const entry = input.entries[i];
  const rawBm25 = input.bm25Scores[i];
  const normBm25 = rawBm25 / input.maxBm25;
  const { strength, recency } = strengthRecencyMultipliers(entry, input.boosts.now);
  let base: number;
  let mode: HybridMode;
  if (input.useEmbeddings) {
    base = input.rrfScores
      ? input.rrfScores.get(i) ?? 0
      : input.bm25Weight * normBm25 + input.embeddingWeight * input.dense.cosine[i];
    mode = input.dense.hadVec[i] ? 'hybrid' : 'hybrid-no-vec';
  } else {
    base = input.queryTerms.length > 0 ? rawBm25 / input.queryTerms.length : rawBm25;
    mode = 'bm25-only';
  }
  const boosts = applyRankBoosts(base * strength * recency, entry, input.boosts);
  return { base, mode, normBm25, strength, recency, boosts };
}

function hybridBreakdown(i: number, s: EntryScore, input: HybridScoreInput, queryTermSet: Set<string>): ScoreBreakdown {
  const entry = input.entries[i];
  const b = s.boosts;
  const breakdown: ScoreBreakdown = {
    mode: s.mode,
    normBm25: s.normBm25,
    bm25Weight: input.useEmbeddings ? input.bm25Weight : 1,
    embeddingWeight: input.useEmbeddings ? input.embeddingWeight : 0,
    cosine: input.dense.cosine[i],
    base: s.base,
    strengthMultiplier: s.strength,
    recencyMultiplier: s.recency,
    decisionBoost: b.decisionBoost,
    pathBoost: b.pathBoost,
    scopeBoost: b.scopeBoost,
    sourceBump: 1,
    outcomeBoost: b.outcomeBoost,
    churnStaleMultiplier: b.churnStaleMultiplier,
    matchedTerms: matchedQueryTerms(queryTermSet, entry),
    final: b.score,
    ageDays: ageInDays(entry, input.boosts.now),
  };
  return addDagFields(breakdown, entry, b.summaryDeboost, b.summaryFreshnessBoost);
}
