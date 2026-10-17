/** Z0 sizing, part 1 of 2: variance components, a chi-square bound, and simulated power of the analyzer's own tests.
 * Every simulated run goes through the analyzer's bootstraps and verdict rules, so the power is the full analysis's (prereg 209). */

import { combineCodings, harmGate, holmAdjust, seededRandom, twoLevelBootstrap, verdict } from '../../dist/eval/eval-stats.js';
import { CODINGS, SPECS, blocks, byCoding, mean, meanBootstrap, ratioBootstrap, sum } from './z0-hypotheses.mjs';

export const SEEDS = 3;
export const H3_RATIO = SPECS.H3.minimumEffectAt;

/** Holm's first step over H1-H3: the size must hold even when this hypothesis has the family's smallest p (prereg 209).
 * @param {number} p */
export const strictest = (p) => holmAdjust([p, Number.NaN, Number.NaN])[0];

/** FNV-1a over the parts, so a design's draws depend on its own coordinates and never on the search order. */
export function cellSeed(...parts) {
  const text = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export const normal = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

/** Abramowitz and Stegun 7.1.26, error below 1.5e-7.
 * @param {number} x */
export function normalCdf(x) {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const tail = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp((-x * x) / 2);
  return x >= 0 ? 1 - tail / 2 : tail / 2;
}

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

function lnGamma(z) {
  const x = z - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// The series alone converges for every x the bisection visits, as quantiles here stay far below the overflow range.
function gammaP(s, x) {
  if (x <= 0) return 0;
  let term = 1 / s;
  let total = term;
  for (let n = 1; n < 10_000 && term > total * 1e-16; n++) {
    term *= x / (s + n);
    total += term;
  }
  return Math.min(1, total * Math.exp(s * Math.log(x) - x - lnGamma(s)));
}

/** @param {number} p @param {number} df */
export function chiSquareQuantile(p, df) {
  const cdf = (x) => gammaP(df / 2, x / 2);
  let hi = Math.max(1, df);
  while (cdf(hi) < p) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const squares = (xs, m) => sum(xs.map((x) => (x - m) ** 2));

/** Nested-means method of moments for repository, family and seed variance, unbiased before the clip at zero.
 * The repository term also gets a one-sided upper bound at `bound` from the chi-square of the repository means,
 * since a handful of development repositories barely estimates it (D6). Null under two repositories.
 * @param {{repo: string, family: string, value: number}[]} units @param {number} bound */
export function varianceComponents(units, bound) {
  const repos = blocks(units).map((fams) => fams.map((us) => us.map((u) => u.value)));
  const a = repos.length;
  if (a < 2) return null;
  const familyMeans = repos.map((fams) => fams.map(mean));
  const seedDf = sum(repos.flatMap((fams) => fams.map((v) => v.length - 1)));
  const seed = seedDf > 0 ? sum(repos.flatMap((fams) => fams.map((v) => squares(v, mean(v))))) / seedDf : 0;
  const familyDf = sum(familyMeans.map((m) => m.length - 1));
  const familyNoise = familyDf > 0 ? (seed * sum(repos.map((fams) => (fams.length - 1) * mean(fams.map((v) => 1 / v.length))))) / familyDf : 0;
  const family = familyDf > 0 ? Math.max(0, sum(familyMeans.map((m) => squares(m, mean(m)))) / familyDf - familyNoise) : 0;
  const repoMeans = familyMeans.map(mean);
  const repoRaw = squares(repoMeans, mean(repoMeans)) / (a - 1);
  const repoNoise = mean(repos.map((fams) => (family + seed * mean(fams.map((v) => 1 / v.length))) / fams.length));
  return {
    repos: a, families: sum(repos.map((f) => f.length)), units: units.length,
    repo: Math.max(0, repoRaw - repoNoise),
    repoUpper: Math.max(0, ((a - 1) * repoRaw) / chiSquareQuantile(1 - bound, a - 1) - repoNoise),
    family, seed, df: { repo: a - 1, family: familyDf, seed: seedDf },
  };
}

const sd = Math.sqrt;
const share = (xs, keep) => xs.filter(keep).length / xs.length;
const bootSeed = (rand) => 1 + Math.floor(rand() * 2 ** 31);

/** One simulated H1 or H2 run: the same draws under both codings, each with its own spread, dilution and unit loss. */
export function repeatRun(cal, design, delta, rand) {
  const out = byCoding(() => []);
  for (let r = 0; r < design.repos; r++) {
    const zr = normal(rand);
    for (let f = 0; f < design.families; f++) {
      const zf = normal(rand);
      for (let s = 1; s <= SEEDS; s++) {
        const [ze, u] = [normal(rand), rand()];
        for (const coding of CODINGS) {
          const c = cal[coding];
          if (u >= c.loss) out[coding].push({ repo: `r${r}`, family: `r${r}f${f}`, seed: s, value: c.scale * delta + sd(c.repo) * zr + sd(c.family) * zf + sd(c.seed) * ze });
        }
      }
    }
  }
  return out;
}

const repeatSpec = (m) => ({ ...SPECS.H1, tieBand: [-m, m], minimumEffectAt: -m });
const decide = (ests, spec) => combineCodings(...CODINGS.map((c) => verdict(ests[c], strictest(ests[c].p), spec)));

/** Power of H1 or H2 per design and minimum effect; the true-zero runs, shared by every effect, are cached.
 * `cal` holds per coding { scale, loss, repo, family, seed }, the variances already at their bound.
 * @param {Record<string, {scale: number, loss: number, repo: number, family: number, seed: number}>} cal
 * @param {{sims: number, iterations: number, seed: number}} opts @param {string} label */
export function repeatSizer(cal, opts, label) {
  const runs = (design, delta) => {
    const rand = seededRandom(cellSeed(opts.seed, label, design.repos, design.families, delta));
    return Array.from({ length: opts.sims }, () => {
      const run = repeatRun(cal, design, delta, rand);
      const seed = bootSeed(rand);
      return byCoding((c) => meanBootstrap(run[c], { iterations: opts.iterations, seed }));
    });
  };
  const zeros = new Map();
  /** @param {{repos: number, families: number}} design @param {number} m */
  return (design, m) => {
    const key = `${design.repos}/${design.families}`;
    if (!zeros.has(key)) zeros.set(key, runs(design, 0));
    const [spec, zero] = [repeatSpec(m), zeros.get(key)];
    return {
      win: share(runs(design, -m), (e) => decide(e, spec).verdict === 'win'),
      tie: share(zero, (e) => decide(e, spec).verdict === 'tie'),
      falseWin: share(zero, (e) => decide(e, spec).verdict === 'win'),
    };
  };
}

/** Log ratios centre at log(ratio) minus half their variance, so the ratio of expected cost sums is the true ratio. */
function costPair(cal, mu, zr, zf, rand) {
  const c = Math.exp(cal.controlSd * normal(rand));
  return { c, t: c * Math.exp(mu + sd(cal.repo) * zr + sd(cal.family) * zf + sd(cal.seed) * normal(rand)) };
}

const centre = (cal, ratio) => Math.log(ratio) - (cal.repo + cal.family + cal.seed) / 2;

/** One simulated H3 run: lesson families of the plan's sizes plus its share of no-lesson tasks, each its own family.
 * A family's pairs are summed into one unit: the bootstrap keeps a family whole and a ratio of sums is additive,
 * so the resamples and the estimate match per-task units exactly, at a fraction of the cost. */
export function ratioRun(cal, layout, design, ratio, rand) {
  const sizes = Array.from({ length: design.families }, (_, f) => layout.familySizes[f % layout.familySizes.length]);
  const noLesson = Math.round(sum(sizes) * layout.noLessonRatio);
  const mu = centre(cal, ratio);
  const units = [];
  const add = (repo, family, set, zr, tasks) => {
    const zf = normal(rand);
    const unit = { repo, family, set, t: { cost: 0 }, c: { cost: 0 } };
    for (let k = 0; k < tasks * SEEDS; k++) {
      const { t, c } = costPair(cal, mu, zr, zf, rand);
      unit.t.cost += t;
      unit.c.cost += c;
    }
    units.push(unit);
  };
  for (let r = 0; r < design.repos; r++) {
    const zr = normal(rand);
    sizes.forEach((n, f) => add(`r${r}`, `r${r}f${f}`, 'R', zr, n));
    for (let k = 0; k < noLesson; k++) add(`r${r}`, `r${r}n${k}`, 'N', zr, 1);
  }
  return units;
}

/** H3 power per design: a win at a true ratio of 0.95 and a tie at 1, under the analyzer's ratio bootstrap. */
export function ratioSizer(cal, layout, opts) {
  const runs = (design, ratio) => {
    const rand = seededRandom(cellSeed(opts.seed, 'H3', design.repos, design.families, ratio));
    return Array.from({ length: opts.sims }, () => {
      const units = ratioRun(cal, layout, design, ratio, rand);
      const e = ratioBootstrap(units, 'cost', { iterations: opts.iterations, seed: bootSeed(rand) });
      return verdict(e, strictest(e.p), SPECS.H3).verdict;
    });
  };
  /** @param {{repos: number, families: number}} design */
  return (design) => {
    const zero = runs(design, 1);
    return { win: share(runs(design, H3_RATIO), (v) => v === 'win'), tie: share(zero, (v) => v === 'tie'), falseWin: share(zero, (v) => v === 'win') };
  };
}

// The analyzer's per-pair resolve difference, over units that each sum `n` pairs.
const resolveDiff = (us) => (sum(us.map((u) => u.t.resolved)) - sum(us.map((u) => u.c.resolved))) / sum(us.map((u) => u.n));

/** One simulated set N run at a true zero: cost ratio 1, and resolve pairs from the symmetrised calibration table.
 * A task's seeds are summed into one unit, exact for both statistics for the reason ratioRun gives. */
export function harmRun(cal, design, rand) {
  const mu = centre(cal, 1);
  const units = [];
  for (let r = 0; r < design.repos; r++) {
    const zr = normal(rand);
    for (let k = 0; k < design.tasks; k++) {
      const zf = normal(rand);
      const unit = { repo: `r${r}`, family: `r${r}n${k}`, n: SEEDS, t: { cost: 0, resolved: 0 }, c: { cost: 0, resolved: 0 } };
      for (let s = 0; s < SEEDS; s++) {
        const { t, c } = costPair(cal, mu, zr, zf, rand);
        const u = rand();
        unit.t.cost += t;
        unit.c.cost += c;
        unit.t.resolved += u < cal.both + cal.oneSide ? 1 : 0;
        unit.c.resolved += u < cal.both || (u >= cal.both + cal.oneSide && u < cal.both + 2 * cal.oneSide) ? 1 : 0;
      }
      units.push(unit);
    }
  }
  return units;
}

/** H4 power per design: the share of true-zero runs whose harm gate passes, as harmGateOf computes it. */
export function harmSizer(cal, opts) {
  /** @param {{repos: number, tasks: number}} design */
  return (design) => {
    const rand = seededRandom(cellSeed(opts.seed, 'H4', design.repos, design.tasks));
    const passes = Array.from({ length: opts.sims }, () => {
      const units = harmRun(cal, design, rand);
      const stat = { iterations: opts.iterations, seed: bootSeed(rand) };
      return harmGate(ratioBootstrap(units, 'cost', stat), twoLevelBootstrap(blocks(units), resolveDiff, { ...stat, nullValue: 0 })).pass;
    });
    return { pass: share(passes, Boolean) };
  };
}

function memoized(evaluate) {
  const memo = new Map();
  return (n) => {
    if (!memo.has(n)) memo.set(n, evaluate(n));
    return memo.get(n);
  };
}

/** Re-checks a coarse search's size at full precision: up while it fails, then down while the size below passes.
 * A coarse miss (`start` null) starts at the cap, so a size above the cap costs one full-precision evaluation.
 * @template T @param {(n: number) => T} evaluate @param {(r: T) => boolean} passes @param {number} cap @param {number | null} start
 * @returns {{n: number | null, result: T | null}} */
export function confirmSize(evaluate, passes, cap, start) {
  if (cap < 1) return { n: null, result: null };
  const at = memoized(evaluate);
  let n = Math.max(1, Math.min(start ?? cap, cap));
  while (n < cap && !passes(at(n))) n++;
  if (!passes(at(n))) return { n: null, result: at(n) };
  while (n > 1 && passes(at(n - 1))) n--;
  return { n, result: at(n) };
}

/** Smallest n in 1..cap whose evaluation passes, by doubling then bisection, assuming power rises with n.
 * Past the cap, `n` is null and `result` is the power at the cap, so a report can say how far short it falls.
 * @template T @param {(n: number) => T} evaluate @param {(r: T) => boolean} passes @param {number} cap
 * @returns {{n: number | null, result: T | null}} */
export function smallestPassing(evaluate, passes, cap) {
  if (cap < 1) return { n: null, result: null };
  const at = memoized(evaluate);
  let [lo, hi] = [0, 1];
  while (hi < cap && !passes(at(hi))) [lo, hi] = [hi, Math.min(cap, hi * 2)];
  if (!passes(at(hi))) return { n: null, result: at(hi) };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(at(mid))) hi = mid;
    else lo = mid;
  }
  return { n: hi, result: at(hi) };
}
