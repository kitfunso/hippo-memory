/**
 * Reciprocal Rank Fusion (Cormack, Clarke, and Buettcher 2009).
 *
 * Fuses N ranked candidate lists into a single ordering by summing
 * weighted 1/(k + rank) contributions per candidate. The constant K is
 * the canonical 60 from the original paper and the value already in use
 * across hippo's `hybridSearch` since v1.0. Do NOT tune K without an
 * explicit cross-corpus eval — it is calibrated against IR benchmarks
 * and works robustly across BM25/dense/cross-encoder rank-list shapes.
 *
 * Generic over the candidate id type so this helper can be shared by
 * `src/search.ts::hybridSearch` (T = number, idx into MemoryEntry[]) and
 * the LongMemEval F9 hybrid retrieve benchmark (T = string, session_id).
 *
 * Behaviour MUST stay byte-identical to the inline implementation that
 * lived in `src/search.ts:354-374` before extraction (commit ab6c5eb).
 * The `tests/rrf.test.ts` suite is the contract.
 */

export const RRF_K = 60;

export interface RrfFuseOptions {
  /** Smoothing constant. Default RRF_K = 60. */
  k?: number;
  /**
   * Rank assigned to candidates absent from a list. Default is
   * `max(rankedLists.map(l => l.length)) + 1` — the convention used in
   * the pre-extraction `hybridSearch` code (`entries.length + 1`).
   */
  absentRank?: number;
}

/**
 * Fuse N ranked lists into a single Map of candidate id -> RRF score.
 *
 * @param rankedLists  Each inner array is candidates in descending-score order.
 *                     Element at index 0 is rank 1; index 1 is rank 2; etc.
 * @param weights      Per-list weights. weights.length === rankedLists.length.
 *                     Weights are summed without normalisation — pass {0.5, 0.5}
 *                     for symmetric fusion or {0.2, 0.8} for asymmetric.
 * @param options      Optional k override + absentRank override.
 * @returns            Map from candidate id to fused RRF score. Sort descending
 *                     by value to get the fused ordering.
 */
export function rrfFuse<T>(
  rankedLists: ReadonlyArray<ReadonlyArray<T>>,
  weights: ReadonlyArray<number>,
  options?: RrfFuseOptions,
): Map<T, number> {
  if (rankedLists.length !== weights.length) {
    throw new Error(
      `rrfFuse: rankedLists.length (${rankedLists.length}) must match weights.length (${weights.length})`,
    );
  }

  const k = options?.k ?? RRF_K;
  const defaultAbsentRank =
    rankedLists.reduce((m, l) => Math.max(m, l.length), 0) + 1;
  const absentRank = options?.absentRank ?? defaultAbsentRank;

  const rankMaps: Array<Map<T, number>> = rankedLists.map((list) => {
    const m = new Map<T, number>();
    for (let i = 0; i < list.length; i++) {
      m.set(list[i], i + 1); // 1-indexed rank
    }
    return m;
  });

  const allCandidates = new Set<T>();
  for (const list of rankedLists) for (const c of list) allCandidates.add(c);

  const scores = new Map<T, number>();
  for (const c of allCandidates) {
    let score = 0;
    for (let i = 0; i < rankMaps.length; i++) {
      const rank = rankMaps[i].get(c) ?? absentRank;
      score += weights[i] / (k + rank);
    }
    scores.set(c, score);
  }
  return scores;
}
