/** Recall eval harness: runs recall over (query, expected_memory_ids) cases and reports MRR, Recall@K and NDCG@K.
 *  It exists so MMR lambda, embedding weights and scoring tweaks are tuned against evidence instead of intuition. */

import type { MemoryEntry } from '../core/memory.js';
import { hybridSearch } from '../search/hybrid.js';
import { searchBothHybrid } from '../sharing/search-both.js';
import { isInitialized } from '../core/project-identity.js';

// Generous so metrics are not truncated.
const DEFAULT_EVAL_BUDGET = 100_000;
const QUERY_WORDS = 8;

export interface EvalCase {
  /** Free-form ID for humans to reference the case. */
  id: string;
  /** The query text to run through recall. */
  query: string;
  /** Memory IDs considered relevant. At least one required. */
  expectedIds: string[];
  /** Optional short description so a failure report is self-explaining. */
  description?: string;
}

export interface EvalCaseResult {
  case: EvalCase;
  returnedIds: string[];
  /** 1 / rank of the first expected id, else 0. */
  mrr: number;
  /** |expected ∩ returned[0..K]| / |expected|, 0 when expected is empty. */
  recallAt5: number;
  recallAt10: number;
  /** Normalized DCG at 10 using binary relevance (expected = 1, else 0). */
  ndcgAt10: number;
}

export interface EvalSummary {
  cases: EvalCaseResult[];
  /** Simple arithmetic means across cases. */
  meanMrr: number;
  meanRecallAt5: number;
  meanRecallAt10: number;
  meanNdcgAt10: number;
  /** Wall-clock runtime in ms for the whole eval. */
  durationMs: number;
}

export interface RunEvalOptions {
  mmr?: boolean;
  mmrLambda?: number;
  embeddingWeight?: number;
  /** Max returned results per case. Larger than K-at-10 so metrics stay honest. */
  budget?: number;
  hippoRoot?: string;
  /** When set and initialized, eval runs through searchBothHybrid so global
   *  memories are in scope. Otherwise only the `entries` list is searched. */
  globalRoot?: string;
  /** Multiplier for local-over-global results when globalRoot is in play. */
  localBump?: number;
  now?: Date;
}

/** Mean Reciprocal Rank for a single ranking given expected ids. */
export function mrr(returned: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  for (let i = 0; i < returned.length; i++) {
    if (expectedSet.has(returned[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Recall@K — fraction of expected items found in the top-K. */
export function recallAtK(returned: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  const topK = returned.slice(0, k);
  let hits = 0;
  for (const id of topK) {
    if (expectedSet.has(id)) hits++;
  }
  return hits / expected.length;
}

/** Normalized Discounted Cumulative Gain at K with binary relevance.
 *  gain_i = 1 if returned[i] ∈ expected else 0. discount = log2(i + 2). */
export function ndcgAtK(returned: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, returned.length); i++) {
    if (expectedSet.has(returned[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  // Ideal DCG: all relevant items at top positions.
  const idealHits = Math.min(k, expected.length);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

export async function runEval(
  cases: EvalCase[],
  entries: MemoryEntry[],
  options: RunEvalOptions = {},
): Promise<EvalSummary> {
  const start = Date.now();
  const results: EvalCaseResult[] = [];

  const useBothStores = Boolean(
    options.globalRoot && options.hippoRoot && isInitialized(options.globalRoot)
  );

  for (const c of cases) {
    const ranked = await rankForCase(c.query, entries, options, useBothStores);
    const returnedIds = ranked.map((r) => r.entry.id);
    results.push({
      case: c,
      returnedIds,
      mrr: mrr(returnedIds, c.expectedIds),
      recallAt5: recallAtK(returnedIds, c.expectedIds, 5),
      recallAt10: recallAtK(returnedIds, c.expectedIds, 10),
      ndcgAt10: ndcgAtK(returnedIds, c.expectedIds, 10),
    });
  }

  const n = Math.max(1, results.length);
  const meanMrr = results.reduce((s, r) => s + r.mrr, 0) / n;
  const meanRecallAt5 = results.reduce((s, r) => s + r.recallAt5, 0) / n;
  const meanRecallAt10 = results.reduce((s, r) => s + r.recallAt10, 0) / n;
  const meanNdcgAt10 = results.reduce((s, r) => s + r.ndcgAt10, 0) / n;

  return {
    cases: results,
    meanMrr,
    meanRecallAt5,
    meanRecallAt10,
    meanNdcgAt10,
    durationMs: Date.now() - start,
  };
}

/** One case's ranking: across the local and global stores when `useBothStores`, else over `entries` alone. */
function rankForCase(query: string, entries: MemoryEntry[], options: RunEvalOptions, useBothStores: boolean) {
  const budget = options.budget ?? DEFAULT_EVAL_BUDGET;
  return useBothStores
    ? searchBothHybrid(query, options.hippoRoot!, options.globalRoot!, {
        budget,
        now: options.now,
        embeddingWeight: options.embeddingWeight,
        mmr: options.mmr,
        mmrLambda: options.mmrLambda,
        localBump: options.localBump,
      })
    : hybridSearch(query, entries, {
        budget,
        now: options.now,
        hippoRoot: options.hippoRoot,
        embeddingWeight: options.embeddingWeight,
        mmr: options.mmr,
        mmrLambda: options.mmrLambda,
      });
}

export interface EvalDelta {
  mrr: number;
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
}

export interface CaseDelta {
  id: string;
  query: string;
  mrrBefore: number;
  mrrAfter: number;
  r10Before: number;
  r10After: number;
  ndcgBefore: number;
  ndcgAfter: number;
}

export interface EvalComparison {
  aggregate: EvalDelta;
  improved: CaseDelta[];
  regressed: CaseDelta[];
  unchanged: number;
  onlyInBaseline: string[];
  onlyInCurrent: string[];
}

/** Compute pairwise deltas between a baseline and a current eval summary, matching cases by EvalCase.id; mismatches land in the onlyIn arrays. */
export function compareSummaries(baseline: EvalSummary, current: EvalSummary): EvalComparison {
  const aggregate: EvalDelta = {
    mrr: current.meanMrr - baseline.meanMrr,
    recallAt5: current.meanRecallAt5 - baseline.meanRecallAt5,
    recallAt10: current.meanRecallAt10 - baseline.meanRecallAt10,
    ndcgAt10: current.meanNdcgAt10 - baseline.meanNdcgAt10,
  };

  const baseById = new Map(baseline.cases.map((c) => [c.case.id, c]));
  const curById = new Map(current.cases.map((c) => [c.case.id, c]));

  const improved: CaseDelta[] = [];
  const regressed: CaseDelta[] = [];
  let unchanged = 0;

  for (const [id, cur] of curById) {
    const base = baseById.get(id);
    if (!base) continue;
    const delta: CaseDelta = {
      id,
      query: cur.case.query,
      mrrBefore: base.mrr,
      mrrAfter: cur.mrr,
      r10Before: base.recallAt10,
      r10After: cur.recallAt10,
      ndcgBefore: base.ndcgAt10,
      ndcgAfter: cur.ndcgAt10,
    };
    const ndcgDelta = delta.ndcgAfter - delta.ndcgBefore;
    if (ndcgDelta > 1e-6) improved.push(delta);
    else if (ndcgDelta < -1e-6) regressed.push(delta);
    else unchanged++;
  }

  return {
    aggregate,
    improved: improved.sort((a, b) => (b.ndcgAfter - b.ndcgBefore) - (a.ndcgAfter - a.ndcgBefore)),
    regressed: regressed.sort((a, b) => (a.ndcgAfter - a.ndcgBefore) - (b.ndcgAfter - b.ndcgBefore)),
    unchanged,
    onlyInBaseline: [...baseById.keys()].filter((id) => !curById.has(id)),
    onlyInCurrent: [...curById.keys()].filter((id) => !baseById.has(id)),
  };
}

/** For each memory, use its first 8 content words as a trivial query and expect that memory back: a smoke test for recall. */
export function bootstrapCorpus(entries: MemoryEntry[], maxCases = 50): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const e of entries) {
    if (cases.length >= maxCases) break;
    const words = e.content.trim().split(/\s+/).filter((w) => w.length > 2);
    if (words.length < 3) continue;
    const query = words.slice(0, QUERY_WORDS).join(' ');
    cases.push({
      id: `bootstrap_${e.id}`,
      query,
      expectedIds: [e.id],
      description: `trivial self-query on memory ${e.id}`,
    });
  }
  return cases;
}
