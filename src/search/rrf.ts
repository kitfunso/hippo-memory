/** Reciprocal Rank Fusion (Cormack, Clarke and Buettcher 2009): fuses N ranked lists by summing weighted 1/(k + rank) per candidate. K is the standard 60,
 * the value hybridSearch already uses; do NOT tune it without a cross-corpus eval. Generic over the id type (hybridSearch uses number, the LongMemEval
 * benchmark string). Behaviour MUST stay byte-identical to the inline hybridSearch code it replaced; tests/rrf.test.ts is the contract. */

export const RRF_K = 60;

export interface RrfFuseOptions {
  /** Smoothing constant. Default RRF_K = 60. */
  k?: number;
  /** Rank assigned to candidates absent from a list; default `max(rankedLists.map(l => l.length)) + 1`, the convention hybridSearch used (`entries.length +
   * 1`). */
  absentRank?: number;
}

/** Fuses N ranked lists (each in descending-score order; index 0 is rank 1) into a Map of candidate id -> RRF score; sort by value descending for the fused
 * order. `weights` has one entry per list and is summed without normalisation; `options` overrides k and absentRank. */
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
