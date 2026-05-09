// benchmarks/sequential-learning/aggregate.mjs
// v1.7.5 -- pure aggregation helpers for multi-seed runs. Zero npm deps; only
// Node 22+ built-ins. Keep this file dependency-free so the benchmark runs on
// a vanilla Node install with `node run.mjs`.

/**
 * Sample mean. Returns 0 for empty arrays.
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Sample standard deviation (n-1 denominator). Returns 0 for n<2.
 * @param {number[]} xs
 * @returns {number}
 */
export function stdDev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sumSq = xs.reduce((a, b) => a + (b - m) ** 2, 0);
  return Math.sqrt(sumSq / (xs.length - 1));
}

// t-distribution critical values for 95% two-sided, df = n - 1.
// Hardcoded for n in [5..30]; falls back to 1.960 (z) for n > 30.
const T_CRIT_95 = {
  5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306, 10: 2.262,
  11: 2.228, 12: 2.201, 13: 2.179, 14: 2.160, 15: 2.145, 16: 2.131,
  17: 2.120, 18: 2.110, 19: 2.101, 20: 2.093, 21: 2.086, 22: 2.080,
  23: 2.074, 24: 2.069, 25: 2.064, 26: 2.060, 27: 2.056, 28: 2.052,
  29: 2.048, 30: 2.045,
};

/**
 * 95% CI half-width via t-distribution. v1.7.5 codex P2 -- reject n<5 by
 * returning 0. n=2 t-crit=12.706 gives nonsense CIs; eval requires n>=10
 * anyway. Smoke runs labelled exploratory, no CI reported.
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function ciHalfWidth95(xs) {
  if (xs.length < 5) return 0;
  const t = T_CRIT_95[xs.length] ?? 1.960;
  return (t * stdDev(xs)) / Math.sqrt(xs.length);
}

/**
 * mulberry32 -- deterministic PRNG, dep-free. Exported so traps.mjs can reuse
 * the same RNG implementation for seeded category-to-slot assignment.
 *
 * @param {number} seed integer seed (uint32 coerced)
 * @returns {() => number} function returning a uniform float in [0, 1)
 */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired permutation CI via recentred-percentile sign-flip Monte Carlo.
 *
 * Implementation: nResamples (default 10,000) sign-flip resamples of paired
 * diffs (xsA[i] - xsB[i]). For each resample, multiply each diff by ±1
 * (random sign), compute the mean, then take the (alpha/2) and (1 - alpha/2)
 * percentiles of the resampled-mean distribution. The interval is then
 * recentred onto the observed mean: ciLow = observed + (loPercentile - mean(resamples)).
 *
 * This is a recentred-percentile interval — NOT bias-corrected (BCa).
 * Sufficient for the symmetric, bounded paired diffs in this benchmark
 * (phase rates ∈ [0, 1], so |diff| ≤ 1).
 *
 * v1.7.5 chose permutation over paired t-test because phase rates are
 * bounded-binomial-like and t-test is fragile at n=20. Permutation makes no
 * normality assumption. P2-3 (v1.7.9): docstring tightened to clarify
 * recentred-percentile (not BCa) and call out the n<5 short-circuit semantics.
 *
 * Throws on n < 5 (callers must ensure sufficient n) and on length mismatch.
 *
 * Internally seeded with mulberry32(0x9E3779B9) for determinism.
 *
 * @param {number[]} xsA per-seed metric for condition A
 * @param {number[]} xsB per-seed metric for condition B (same seeds, paired)
 * @param {number} [alpha=0.05] two-sided alpha for 95% CI
 * @param {number} [nResamples=10000] permutation resample count
 * @returns {{deltaMean: number, ciLow: number, ciHigh: number}}
 */
export function pairedPermutationCI(xsA, xsB, alpha = 0.05, nResamples = 10_000) {
  if (xsA.length !== xsB.length) {
    throw new Error('pairedPermutationCI: lengths differ');
  }
  const n = xsA.length;
  if (n < 5) throw new Error('pairedPermutationCI: n<5');

  const diffs = xsA.map((a, i) => a - xsB[i]);
  const observed = mean(diffs);

  const rng = mulberry32(0x9E3779B9);
  const resampledMeans = new Array(nResamples);
  for (let r = 0; r < nResamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += diffs[i] * (rng() < 0.5 ? -1 : 1);
    }
    resampledMeans[r] = s / n;
  }
  resampledMeans.sort((a, b) => a - b);
  const resampleMean = mean(resampledMeans);
  const loIdx = Math.floor((alpha / 2) * nResamples);
  const hiIdx = Math.ceil((1 - alpha / 2) * nResamples) - 1;
  const ciLow = observed + (resampledMeans[loIdx] - resampleMean);
  const ciHigh = observed + (resampledMeans[hiIdx] - resampleMean);
  return { deltaMean: observed, ciLow, ciHigh };
}

/**
 * Aggregate per-seed phase rates into mean/std/ci95 per phase.
 *
 * @param {Array<{early: number, mid: number, late: number}>} seedResults
 * @returns {{
 *   early: {mean: number, std: number, ci95: number},
 *   mid:   {mean: number, std: number, ci95: number},
 *   late:  {mean: number, std: number, ci95: number},
 * }}
 */
export function aggregatePhases(seedResults) {
  const result = {};
  for (const phase of ['early', 'mid', 'late']) {
    const xs = seedResults.map((r) => r[phase]);
    result[phase] = {
      mean: mean(xs),
      std: stdDev(xs),
      ci95: ciHalfWidth95(xs),
    };
  }
  return result;
}
