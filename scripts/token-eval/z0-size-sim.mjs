/** Z0 sizing, part 1 of 2: family, sequence and noise spreads with chi-square bounds, the blind seed rule, and simulated power
 * of the analyzer's own tests. Repositories are fixed (Amendment 2): every run goes through the analyzer's family t tests
 * and verdict rules, so the power is the full analysis's (prereg 209). */

import { combineCodings, holmAdjust, seededRandom, verdict } from '../../dist/eval/eval-stats.js';
import { incompleteBeta, lnGamma, pooledComponents } from '../../dist/eval/repository-t.js';
import { CODINGS, SPECS, byCoding, harmT, mean, repeatT, sum } from './z0-hypotheses.mjs';

/** Seeds in the first wave; the seed rule may add more up to SEED_CAP. */
export const SEEDS = 3;
export const SEED_CAP = 9;
/** The seed rule aims for a standard error of at most the minimum effect over this. */
export const TARGET_Z = 3.5;
// Holm's strictest level over H1 and H2 (prereg 209): the share of true-zero runs below it is the test's level.
const LEVEL = 0.025;

/** Holm's first step over H1 and H2: the size must hold even when this hypothesis has the family's smallest p (prereg 209).
 * @param {number} p */
export const strictest = (p) => holmAdjust([p, Number.NaN])[0];

/** FNV-1a over the parts, so a design's draws depend on its own coordinates and never on the search order. */
export function cellSeed(...parts) {
  const text = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export const normal = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

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

const sd = Math.sqrt;
const share = (xs, keep) => xs.filter(keep).length / xs.length;

// The expected mean squares are E = noise, F = noise + s family and Q = noise + k sequence, so each spread is its excess over E.
function pointSpreads({ F, Q, E, sBar, kBar }) {
  return { noise: E, family: Math.max(0, (F - E) / sBar), sequence: Math.max(0, (Q - E) / kBar) };
}

// One-sided upper bound of a mean square at `bound`; with no df there is nothing to widen.
const upperOf = (ms, df, bound) => (df > 0 ? (df * ms) / chiSquareQuantile(1 - bound, df) : ms);

/** Family, sequence and noise spreads from the analyzer's pooled mean squares, each also at a one-sided upper bound at
 * `bound` (a few development repositories barely estimate them, D6). Null when no repository can be fitted.
 * @param {{repo: string, family: string, seed: number, value: number}[]} units @param {number} bound */
export function spreadComponents(units, bound) {
  const pooled = pooledComponents(units);
  if (pooled === null) return null;
  const { F, Q, E, dfF, dfQ, dfE, sBar, kBar } = pooled;
  const at = pointSpreads(pooled);
  const upper = pointSpreads({ F: upperOf(F, dfF, bound), Q: upperOf(Q, dfQ, bound), E: upperOf(E, dfE, bound), sBar, kBar });
  return {
    repos: pooled.repos.length, families: sum(pooled.repos.map((r) => r.k)), units: units.length,
    ...at, upper, df: { family: dfF, sequence: dfQ, noise: dfE }, sBar, kBar,
  };
}

/** The blind seed rule (prereg Amendment 2 item 5): from first-wave units only, the fewest seeds from SEEDS up to `cap` at which
 * the predicted standard error of the estimate is at most m / targetZ; null when the cap misses or nothing can be fitted.
 * @param {{repo: string, family: string, seed: number, value: number}[]} units @param {number} m
 * @param {{cap?: number, targetZ?: number}} [opts] */
export function seedsNeeded(units, m, opts = {}) {
  const pooled = pooledComponents(units);
  if (pooled === null) return null;
  const { family, sequence, noise } = pointSpreads(pooled);
  const variance = (seeds) => sum(pooled.repos.map((r) => family / r.k + sequence / seeds + noise / (r.k * seeds))) / pooled.repos.length ** 2;
  const bar = m / (opts.targetZ ?? TARGET_Z);
  for (let seeds = SEEDS; seeds <= (opts.cap ?? SEED_CAP); seeds++) if (sd(variance(seeds)) <= bar) return seeds;
  return null;
}

/** Exact one-sided upper bound of a binomial share: the p at which P(X <= d | n, p) = 1 - level, by bisection.
 * @param {number} d @param {number} n @param {number} level */
export function clopperPearsonUpper(d, n, level) {
  if (d >= n) return 1;
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    // P(X <= d) falls as p rises.
    if (incompleteBeta(1 - mid, n - d, d + 1) > 1 - level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const effectOf = (c, delta, zf, zq, ze) => c.scale * delta + sd(c.family) * zf + sd(c.sequence) * zq + sd(c.noise) * ze;
const normals = (n, rand) => Array.from({ length: n }, () => normal(rand));

/** One simulated H1 or H2 run: the same draws under both codings, each with its own spread, dilution and unit loss. Family
 * effects are drawn first and a sequence effect per seed, so seeds the rule adds later extend the same families. With a
 * `rule` of { m, cap, targetZ } the first wave is SEEDS and the rule sets the count; `stopped` means it could not.
 * @param {Record<string, {scale: number, loss: number, family: number, sequence: number, noise: number}>} cal
 * @param {{repos: number, families: number, seeds?: number}} design @param {number} delta
 * @param {{m: number, cap?: number, targetZ?: number} | null} [rule] */
export function repeatRun(cal, design, delta, rand, rule = null) {
  const zf = Array.from({ length: design.repos }, () => normals(design.families, rand));
  const units = byCoding(() => []);
  let seeds = 0;
  const addSeed = () => {
    seeds++;
    for (let r = 0; r < design.repos; r++) {
      const zq = normal(rand);
      for (let f = 0; f < design.families; f++) {
        const [ze, u] = [normal(rand), rand()];
        for (const coding of CODINGS) {
          const c = cal[coding];
          if (u >= c.loss) units[coding].push({ repo: `r${r}`, family: `r${r}f${f}`, seed: seeds, value: effectOf(c, delta, zf[r][f], zq, ze) });
        }
      }
    }
  };
  const drawTo = (n) => {
    while (seeds < n) addSeed();
  };
  if (rule === null) {
    drawTo(design.seeds ?? SEEDS);
    return { units, seeds, stopped: false };
  }
  drawTo(SEEDS);
  const needed = CODINGS.map((c) => seedsNeeded(units[c], rule.m, rule));
  if (needed.includes(null)) return { units, seeds, stopped: true };
  drawTo(Math.max(...needed));
  return { units, seeds, stopped: false };
}

// A stopped run scores nothing, so it carries no estimates.
const analysed = (run) => ({ seeds: run.seeds, stopped: run.stopped, est: run.stopped ? null : byCoding((c) => repeatT(run.units[c], {})) });

const repeatSpec = (m) => ({ ...SPECS.H1, tieBand: [-m, m], minimumEffectAt: -m });
const decide = (ests, spec) => combineCodings(...CODINGS.map((c) => verdict(ests[c], strictest(ests[c].p), spec)));

/** Power of H1 or H2 per design and minimum effect; the true-zero runs are cached per design and effect, as the seed rule's
 * target depends on it. A run the rule stops counts in every denominator and is neither a win, a tie nor a false win.
 * `rule: false` draws `opts.seeds` (default SEEDS) seeds in every run instead.
 * @param {Record<string, {scale: number, loss: number, family: number, sequence: number, noise: number}>} cal
 * @param {{sims: number, seed: number, cap?: number, targetZ?: number, rule?: boolean, seeds?: number}} opts @param {string} label */
export function repeatSizer(cal, opts, label) {
  const [ruleOn, fixed] = [opts.rule !== false, opts.seeds ?? SEEDS];
  const runs = (design, delta, m) => {
    const rand = seededRandom(cellSeed(opts.seed, label, design.repos, design.families, m, ruleOn ? 'rule' : `seeds ${fixed}`, delta));
    const rule = ruleOn ? { m, cap: opts.cap ?? SEED_CAP, targetZ: opts.targetZ ?? TARGET_Z } : null;
    return Array.from({ length: opts.sims }, () => analysed(repeatRun(cal, { ...design, seeds: fixed }, delta, rand, rule)));
  };
  const zeros = new Map();
  /** @param {{repos: number, families: number}} design @param {number} m */
  return (design, m) => {
    const key = `${design.repos}/${design.families}/${m}`;
    if (!zeros.has(key)) zeros.set(key, runs(design, 0, m));
    const [spec, zero, effect] = [repeatSpec(m), zeros.get(key), runs(design, -m, m)];
    const is = (name) => (r) => !r.stopped && decide(r.est, spec).verdict === name;
    const drawn = [...effect, ...zero];
    return {
      win: share(effect, is('win')), tie: share(zero, is('tie')), falseWin: share(zero, is('win')),
      meanSeeds: mean(drawn.map((r) => r.seeds)), stopShare: share(drawn, (r) => r.stopped),
    };
  };
}

/** Log ratios centre at log(ratio) minus half their variance, so the ratio of expected cost sums is the true ratio. */
function costPair(cal, mu, zf, zq, rand) {
  const c = Math.exp(cal.controlSd * normal(rand));
  return { c, t: c * Math.exp(mu + sd(cal.family) * zf + sd(cal.sequence) * zq + sd(cal.noise) * normal(rand)) };
}

const centre = (cal, ratio) => Math.log(ratio) - (cal.family + cal.sequence + cal.noise) / 2;

/** One simulated set N run at a true cost ratio (1 unless given), with resolve pairs from the symmetrised calibration table.
 * One unit per (task, seed): a task's cost shares its family effect, and a seed's its sequence effect, inside the repository.
 * @param {{family: number, sequence: number, noise: number, controlSd: number, both: number, oneSide: number}} cal
 * @param {{repos: number, tasks: number, seeds?: number}} design */
export function harmRun(cal, design, rand, ratio = 1) {
  const [mu, seeds] = [centre(cal, ratio), design.seeds ?? SEEDS];
  const units = [];
  for (let r = 0; r < design.repos; r++) {
    const [zf, zq] = [normals(design.tasks, rand), normals(seeds, rand)];
    for (let k = 0; k < design.tasks; k++) {
      for (let s = 1; s <= seeds; s++) {
        const { t, c } = costPair(cal, mu, zf[k], zq[s - 1], rand);
        const u = rand();
        units.push({
          repo: `r${r}`, family: `r${r}n${k}`, seed: s,
          t: { cost: t, resolved: u < cal.both + cal.oneSide ? 1 : 0 },
          c: { cost: c, resolved: u < cal.both || (u >= cal.both + cal.oneSide && u < cal.both + 2 * cal.oneSide) ? 1 : 0 },
        });
      }
    }
  }
  return units;
}

/** H4 power per design: the share of true-zero runs whose harm gate passes, as harmGateOf computes it. */
export function harmSizer(cal, opts) {
  /** @param {{repos: number, tasks: number}} design */
  return (design) => {
    const rand = seededRandom(cellSeed(opts.seed, 'H4', design.repos, design.tasks));
    const full = { ...design, seeds: opts.seeds ?? SEEDS };
    const passes = Array.from({ length: opts.sims }, () => harmT(harmRun(cal, full, rand), {}).gate.pass);
    return { pass: share(passes, Boolean) };
  };
}

// Resolve-style 0/1 values: each unit is the difference of two Bernoulli draws at one p, so its true mean is zero.
function binaryRun(cal, design, rand) {
  const units = byCoding(() => []);
  const zf = Array.from({ length: design.repos }, () => normals(design.families, rand));
  for (let r = 0; r < design.repos; r++) {
    const zq = normals(design.seeds, rand);
    for (let f = 0; f < design.families; f++) {
      for (let s = 1; s <= design.seeds; s++) {
        const [b1, b2, u] = [rand(), rand(), rand()];
        for (const coding of CODINGS) {
          const c = cal[coding];
          const p = Math.min(0.98, Math.max(0.02, 0.3 + sd(c.family) * zf[r][f] + sd(c.sequence) * zq[s - 1]));
          if (u >= c.loss) units[coding].push({ repo: `r${r}`, family: `r${r}f${f}`, seed: s, value: Number(b1 < p) - Number(b2 < p) });
        }
      }
    }
  }
  return units;
}

/** The level of the H1 or H2 test at a chosen design: the share of true-zero runs whose p is below Holm's strictest 0.025,
 * per coding, under the seed rule at the bounds, 3 and 2 fixed seeds, and 0/1 values. Stopped runs are left out of both counts.
 * `held` is true when every level is at most 2 simulation errors above 0.025.
 * @param {Record<string, any>} calPoint @param {Record<string, any>} calUpper
 * @param {{repos: number, families: number}} design @param {number} m
 * @param {{sims: number, seed: number, cap?: number, targetZ?: number, label?: string}} opts */
export function levelCheck(calPoint, calUpper, design, m, opts) {
  const rule = { m, cap: opts.cap ?? SEED_CAP, targetZ: opts.targetZ ?? TARGET_Z };
  const [three, two] = [{ ...design, seeds: SEEDS }, { ...design, seeds: 2 }];
  const cases = [
    ['rule at bounds', (rand) => analysed(repeatRun(calUpper, three, 0, rand, rule))],
    ['three seeds', (rand) => analysed(repeatRun(calPoint, three, 0, rand))],
    ['two seeds at bounds', (rand) => analysed(repeatRun(calUpper, two, 0, rand))],
    ['0/1 values', (rand) => analysed({ units: binaryRun(calUpper, three, rand), seeds: SEEDS, stopped: false })],
  ];
  const cells = cases.flatMap(([name, make]) => {
    const rand = seededRandom(cellSeed(opts.seed, 'level', opts.label ?? '', name, design.repos, design.families, m));
    const runs = Array.from({ length: opts.sims }, () => make(rand)).filter((r) => !r.stopped);
    return CODINGS.map((coding) => ({ name, coding, level: share(runs, (r) => r.est[coding].p < LEVEL), runs: runs.length }));
  });
  const ceiling = LEVEL + 2 * sd((LEVEL * (1 - LEVEL)) / opts.sims);
  return { cells, ceiling, held: cells.every((c) => c.level <= ceiling) };
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
