/** Student t tests over repositories, with G-1 degrees of freedom: one value per repository, so a shared-store fault
 *  counts once. The t distribution is written here because the package carries no statistics library. */

import { notANumber, type TestedEstimate } from './eval-stats.js';

const ALPHA = 0.05;
// Equal repository values can leave float noise in the spread; at this size it reads as no spread at all.
const FLAT = 1e-12;

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Gamma(z) for z >= 0.5, by the Lanczos series (g 7, nine terms). */
export function lnGamma(z: number): number {
  const x = z - 1;
  let a = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i]! / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Modified Lentz on the incomplete beta continued fraction; it converges fast where x < (a + 1) / (a + b + 2).
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const nonZero = (v: number): number => (Math.abs(v) < tiny ? tiny : v);
  let c = 1;
  let d = 1 / nonZero(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 / nonZero(1 + even * d);
    c = nonZero(1 + even / c);
    h *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 / nonZero(1 + odd * d);
    c = nonZero(1 + odd / c);
    h *= d * c;
    if (Math.abs(d * c - 1) < 1e-15) return h;
  }
  throw new Error(`incomplete beta did not converge at a ${a}, b ${b}, x ${x}`);
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}

// Two-sided tail P(|T| >= |t|), from the beta form so a small p never loses digits to 1 - cdf.
const twoSidedTail = (t: number, df: number): number => incompleteBeta(df / (df + t * t), df / 2, 0.5);

/** Student t cumulative distribution P(T <= t) with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  const tail = twoSidedTail(t, df) / 2;
  return t > 0 ? 1 - tail : tail;
}

/** Student t quantile: the t with P(T <= t) = p, found by bisection on the CDF. */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || !(df > 0)) throw new RangeError(`studentTQuantile needs 0 < p < 1 and df > 0, got p ${p}, df ${df}`);
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  let hi = 1;
  while (studentTCdf(hi, df) < p) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 200 && hi - lo > 1e-15 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const critical = new Map<number, number>();
// The sizer asks for the same few df thousands of times, so each df's critical value is found once.
function criticalValue(df: number): number {
  if (!critical.has(df)) critical.set(df, studentTQuantile(1 - ALPHA / 2, df));
  return critical.get(df)!;
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

/** A 95% t interval and a two-sided p against `nullValue`.
 *  With no spread the interval is the estimate itself, and p is 1 on the null and 0 off it. */
function tResult(estimate: number, se: number, df: number, nullValue: number): TestedEstimate {
  if (!Number.isFinite(estimate) || !Number.isFinite(se)) return notANumber(nullValue, 0);
  const base = { estimate, iterations: 0, dropped: 0, nullValue, df };
  if (se <= FLAT * Math.max(1, Math.abs(estimate))) {
    const onNull = Math.abs(estimate - nullValue) <= FLAT * Math.max(1, Math.abs(nullValue));
    return { ...base, low: estimate, high: estimate, p: onNull ? 1 : 0, se: 0 };
  }
  const half = criticalValue(df) * se;
  return { ...base, low: estimate - half, high: estimate + half, p: twoSidedTail((estimate - nullValue) / se, df), se };
}

/** One-sample t test on per-repository values: the mean, se = sd / sqrt(G), G-1 degrees of freedom.
 *  Fewer than two repositories give the not-a-number result. */
export function repositoryT(values: readonly number[], nullValue = 0): TestedEstimate {
  const g = values.length;
  if (g < 2) return notANumber(nullValue, 0);
  const mean = sum(values) / g;
  const sd = Math.sqrt(sum(values.map((v) => (v - mean) ** 2)) / (g - 1));
  return tResult(mean, sd / Math.sqrt(g), g - 1, nullValue);
}

/** One repository's summed treatment and control values. */
export interface RepoSums {
  readonly t: number;
  readonly c: number;
}

/** Pooled ratio sum(t) / sum(c) over repositories against a null of 1, with a cluster-robust standard error
 *  (residuals t - ratio x c per repository, scaled by G / (G-1)) and G-1 degrees of freedom. */
export function clusterRatioT(repos: readonly RepoSums[]): TestedEstimate {
  const g = repos.length;
  if (g < 2) return notANumber(1, 0);
  const c = sum(repos.map((r) => r.c));
  const ratio = sum(repos.map((r) => r.t)) / c;
  const squares = sum(repos.map((r) => (r.t - ratio * r.c) ** 2));
  return tResult(ratio, Math.sqrt((g / (g - 1)) * squares) / Math.abs(c), g - 1, 1);
}

/** The mean of the per-repository ratios t / c by Cox's lognormal-mean interval: a t interval on the log ratios, centred
 *  on their mean plus half their variance and widened for that variance's own noise; p tests that centre against 1.
 *  Each repository counts once, and `se` is on the log scale. A sum that is not positive gives the not-a-number result. */
export function coxRatioT(repos: readonly RepoSums[]): TestedEstimate {
  const g = repos.length;
  if (g < 2 || !repos.every((r) => r.t > 0 && r.c > 0)) return notANumber(1, 0);
  const logs = repos.map((r) => Math.log(r.t / r.c));
  const mean = sum(logs) / g;
  const s2 = sum(logs.map((y) => (y - mean) ** 2)) / (g - 1);
  const log = tResult(mean + s2 / 2, Math.sqrt(s2 / g + (s2 * s2) / (2 * (g - 1))), g - 1, 0);
  return { ...log, estimate: Math.exp(log.estimate), low: Math.exp(log.low), high: Math.exp(log.high), nullValue: 1 };
}
