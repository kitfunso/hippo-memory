/** Z0 sizing, part 1 of 2: family, sequence and noise spreads with chi-square bounds, the blind seed rule, and simulated power
 * of the analyzer's own tests. Repositories are fixed (Amendment 2): every run goes through the analyzer's family t tests
 * and verdict rules, so the power is the full analysis's (prereg 209). */

import { combineCodings, holmAdjust, seededRandom, verdict } from '../../dist/eval/eval-stats.js';
import { fixedRepositoryT, incompleteBeta, lnGamma, pooledComponents } from '../../dist/eval/repository-t.js';
import { blocks, costSolvedT, weightedVariance } from './z0-cost-solved.mjs';
import { CODINGS, SPECS, byCoding, harmT, mean, repeatT, sum } from './z0-hypotheses.mjs';
import { SEED_CAP } from './z0-records.mjs';
import { T_NULLS, scoreTest } from './z0-verdict-r4.mjs';

/** Seeds in the first wave; the seed rule may add more up to SEED_CAP. */
export const SEEDS = 3;
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
const rawSpreads = ({ F, Q, E, sBar, kBar }) => ({ noise: E, family: (F - E) / sBar, sequence: (Q - E) / kBar });
function pointSpreads(pooled) {
  const raw = rawSpreads(pooled);
  return { ...raw, family: Math.max(0, raw.family), sequence: Math.max(0, raw.sequence) };
}

/** The spreads before the clamp at 0, so the Sizer's recovery check can average them without the clamp's upward bias.
 * @param {{repo: string, family: string, seed: number, value: number}[]} units */
export function unclampedSpreads(units) {
  const pooled = pooledComponents(units);
  return pooled === null ? null : rawSpreads(pooled);
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
  // Each spread widens its own mean square only: raising E too subtracts more and pulls the family and sequence bounds to 0.
  const upper = { ...pointSpreads({ F: upperOf(F, dfF, bound), Q: upperOf(Q, dfQ, bound), E, sBar, kBar }), noise: upperOf(E, dfE, bound) };
  return {
    repos: pooled.repos.length, families: sum(pooled.repos.map((r) => r.k)), units: units.length,
    ...at, upper, df: { family: dfF, sequence: dfQ, noise: dfE }, sBar, kBar,
  };
}

// An entry with no integer k draws no families, so every p would read 1 and every size 0; a layout of that kind stops the run instead.
function checkedLayout(layout, who) {
  if (!Array.isArray(layout) || layout.length === 0) throw new Error(`${who}: layout must be a non-empty array of { repo, k }`);
  const bad = layout.findIndex((e) => String(e?.repo) !== e?.repo || !Number.isInteger(e.k) || e.k < 1);
  if (bad >= 0) throw new Error(`${who}: layout entry ${bad} needs a string repo and an integer k of 1 or more, got ${JSON.stringify(layout[bad])}`);
  return layout;
}

// A layout names the repositories and families a run will have; without one, `repos` and `families` must be positive integers, or no unit would be drawn.
function layoutFor(design) {
  if (design.layout) return checkedLayout(design.layout, 'design');
  const whole = (n) => Number.isInteger(n) && n >= 1;
  if (!whole(design.repos) || !whole(design.families)) throw new Error(`repeatRun: design needs a layout or a positive integer repos and families, got ${JSON.stringify(design)}`);
  return Array.from({ length: design.repos }, (_, r) => ({ repo: `r${r}`, k: design.families }));
}

// One pooled fit gives the predicted error at any count, so a rule's loop never refits.
function predictor(units, layout) {
  if (layout) checkedLayout(layout, 'rule');
  const pooled = pooledComponents(units);
  if (pooled === null) return null;
  const { family, sequence, noise } = pointSpreads(pooled);
  const sized = layout ?? pooled.repos;
  return (seeds) => sd(sum(sized.map((r) => family / r.k + sequence / seeds + noise / (r.k * seeds))) / sized.length ** 2);
}

/** The standard error the blind seed rule predicts at `seeds`, from first-wave units' spreads; null when nothing can be fitted.
 * @param {{repo: string, family: string, seed: number, value: number}[]} units @param {number} seeds
 * @param {{layout?: {repo: string, k: number}[]}} [opts] */
export function predictedSe(units, seeds, opts = {}) {
  return predictor(units, opts.layout)?.(seeds) ?? null;
}

/** The rule's count: the fewest seeds from SEEDS to `cap` at which `predictedSe` is at most m / targetZ. On a miss (or nothing to fit),
 * onMiss 'stop' gives null, 'cap' gives the cap, and 'near' the fewest seeds within `near` times the error at the cap (prereg item 10).
 * @param {{repo: string, family: string, seed: number, value: number}[]} units
 * @param {{m: number, cap?: number, targetZ?: number, onMiss?: 'stop' | 'cap' | 'near', near?: number, layout?: {repo: string, k: number}[]}} rule */
export function ruleSeeds(units, rule) {
  const { m, onMiss, near, layout } = rule;
  const [cap, targetZ] = [rule.cap ?? SEED_CAP, rule.targetZ ?? TARGET_Z];
  if (onMiss === 'near' && !Number.isFinite(near)) throw new Error("ruleSeeds: onMiss 'near' needs rule.near, the multiple of the cap's error to accept");
  const se = predictor(units, layout);
  if (se !== null) for (let seeds = SEEDS; seeds <= cap; seeds++) if (se(seeds) <= m / targetZ) return seeds;
  if (onMiss === 'cap' || (onMiss === 'near' && se === null)) return cap;
  if (onMiss !== 'near') return null;
  const limit = near * se(cap);
  for (let seeds = SEEDS; seeds < cap; seeds++) if (se(seeds) <= limit) return seeds;
  return cap;
}

/** The blind seed rule (prereg Amendment 2 item 5): from first-wave units only, the fewest seeds from SEEDS up to `cap` at which
 * the predicted standard error of the estimate is at most m / targetZ; null when the cap misses or nothing can be fitted.
 * @param {{repo: string, family: string, seed: number, value: number}[]} units @param {number} m
 * @param {{cap?: number, targetZ?: number, layout?: {repo: string, k: number}[]}} [opts] */
export function seedsNeeded(units, m, opts = {}) {
  return ruleSeeds(units, { m, cap: opts.cap, targetZ: opts.targetZ, layout: opts.layout });
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

const effectOf = (c, mu, zf, zq, ze) => mu + sd(c.family) * zf + sd(c.sequence) * zq + sd(c.noise) * ze;
const normals = (n, rand) => Array.from({ length: n }, () => normal(rand));

// Part (a)'s draws are pseudo-values log R + v, so its estimate is the plain mean and its error is item 3's weighted variance.
const SCORERS = {
  repeat: (units) => {
    const { estimate, se, df } = fixedRepositoryT(units, 0);
    return { estimate, se, df };
  },
  ratio: (units) => {
    const spread = weightedVariance(units, units.map((u) => u.value));
    return { estimate: mean(units.map((u) => u.value)), se: spread === null ? Number.NaN : sd(spread.v), df: spread === null ? Number.NaN : spread.df };
  },
};

/** One simulated H1 or H2 run, both codings from the same draws; `ruleSeeds` sets the count under a rule, and later seeds extend the same families.
 * `opts.score` adds `stat` per coding for `scoreTest`; `opts.exact` puts every cell at `delta`, not scale x delta.
 * @param {Record<string, {scale: number, loss: number, family: number, sequence: number, noise: number}>} cal
 * @param {{repos?: number, families?: number, layout?: {repo: string, k: number}[], seeds?: number}} design @param {number} delta
 * @param {{m: number, cap?: number, targetZ?: number, onMiss?: 'stop' | 'cap' | 'near', near?: number} | null} [rule]
 * @param {{score?: 'repeat' | 'ratio', exact?: boolean}} [opts]
 * @returns {{units: Record<string, {repo: string, family: string, seed: number, value: number}[]>, seeds: number, stopped: boolean, stat?: Record<string, {estimate: number, se: number, df: number}> | null}} */
export function repeatRun(cal, design, delta, rand, rule = null, opts = {}) {
  const scorer = opts.score === undefined ? null : SCORERS[opts.score];
  if (opts.score !== undefined && !scorer) throw new Error(`repeatRun: score ${opts.score} is not repeat or ratio`);
  const layout = layoutFor(design);
  const zf = layout.map(({ k }) => normals(k, rand));
  const units = byCoding(() => []);
  let seeds = 0;
  const addSeed = () => {
    seeds++;
    for (let r = 0; r < layout.length; r++) {
      const zq = normal(rand);
      for (let f = 0; f < layout[r].k; f++) {
        const [ze, u] = [normal(rand), rand()];
        for (const coding of CODINGS) {
          const c = cal[coding];
          if (u >= c.loss) units[coding].push({ repo: layout[r].repo, family: `${layout[r].repo}f${f}`, seed: seeds, value: effectOf(c, opts.exact ? delta : c.scale * delta, zf[r][f], zq, ze) });
        }
      }
    }
  };
  const drawTo = (n) => {
    while (seeds < n) addSeed();
  };
  const finish = (stopped) => {
    const run = { units, seeds, stopped };
    if (scorer !== null) run.stat = stopped ? null : byCoding((c) => scorer(units[c]));
    return run;
  };
  if (rule === null) {
    drawTo(design.seeds ?? SEEDS);
    return finish(false);
  }
  drawTo(SEEDS);
  const needed = CODINGS.map((c) => ruleSeeds(units[c], { ...rule, layout: design.layout ?? rule.layout }));
  if (needed.includes(null)) return finish(true);
  drawTo(Math.max(...needed));
  return finish(false);
}

// A stopped run scores nothing, so it carries no estimates.
const analysed = (run) => ({ seeds: run.seeds, stopped: run.stopped, est: run.stopped ? null : byCoding((c) => repeatT(run.units[c], {})) });

const repeatSpec = (m) => ({ ...SPECS.H1, tieBand: [-m, m], minimumEffectAt: -m });
const decide = (ests, spec) => combineCodings(...CODINGS.map((c) => verdict(ests[c], strictest(ests[c].p), spec)));

/** Power of H1 or H2 per design and minimum effect; the true-zero runs are cached per design and effect, as the seed rule's
 * target depends on it. A run the rule stops counts in every denominator and is neither a win, a tie nor a false win.
 * `rule: false` draws `opts.seeds` (default SEEDS) seeds in every run instead.
 * @param {Record<string, {scale: number, loss: number, family: number, sequence: number, noise: number}>} cal
 * @param {{sims: number, seed: number, cap?: number, targetZ?: number, onMiss?: 'stop' | 'cap', rule?: boolean, seeds?: number}} opts @param {string} label */
export function repeatSizer(cal, opts, label) {
  const [ruleOn, fixed] = [opts.rule !== false, opts.seeds ?? SEEDS];
  const runs = (design, delta, m) => {
    const rand = seededRandom(cellSeed(opts.seed, label, design.repos, design.families, m, ruleOn ? 'rule' : `seeds ${fixed}`, delta));
    const rule = ruleOn ? { m, cap: opts.cap ?? SEED_CAP, targetZ: opts.targetZ ?? TARGET_Z, onMiss: opts.onMiss } : null;
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

/** Resolve-style 0/1 values: the treatment's rate is the control's (`base` plus the spreads, clamped so both stay in [0.02, 0.98]) plus
 * `shift`, so each cell's true mean is `shift`; at shift 0 this is round 3's draw.
 * @param {{repos?: number, families?: number, layout?: {repo: string, k: number}[], seeds: number}} design @param {{base?: number, shift?: number}} [opts] */
export function binaryRun(cal, design, rand, { base = 0.3, shift = 0 } = {}) {
  const units = byCoding(() => []);
  const layout = layoutFor(design);
  const zf = layout.map(({ k }) => normals(k, rand));
  const [low, high] = [Math.max(0.02, 0.02 - shift), Math.min(0.98, 0.98 - shift)];
  for (let r = 0; r < layout.length; r++) {
    const zq = normals(design.seeds, rand);
    for (let f = 0; f < layout[r].k; f++) {
      for (let s = 1; s <= design.seeds; s++) {
        const [b1, b2, u] = [rand(), rand(), rand()];
        for (const coding of CODINGS) {
          const c = cal[coding];
          const p = Math.min(high, Math.max(low, base + sd(c.family) * zf[r][f] + sd(c.sequence) * zq[s - 1]));
          if (u >= c.loss) units[coding].push({ repo: layout[r].repo, family: `${layout[r].repo}f${f}`, seed: s, value: Number(b1 < p + shift) - Number(b2 < p) });
        }
      }
    }
  }
  return units;
}

const swapArms = (c) => ({ ...c, Ct: c.Cc, Cc: c.Ct, St: c.Sc, Sc: c.St });
const copyOf = (c, part, swapped) => (part === 'a' ? (swapped ? swapArms(c) : c) : { value: (swapped ? -c.value : c.value) - 0.03 });

/** One resampled draw: each repository redraws its families with replacement, all seeds each, and swaps each copy's arms with probability 1/2.
 * Part 'a' takes cost cells and scores `costSolvedT` (true log R 0); part 'b' takes `partBValues` cells, takes 0.03 off every value (true -0.03).
 * @param {Record<string, any>[]} cells @param {'a' | 'b'} part */
export function resampledRun(cells, rand, part) {
  if (part !== 'a' && part !== 'b') throw new Error(`resampledRun: part ${part} is not a or b`);
  const drawn = [];
  for (const families of blocks(cells)) {
    for (let i = 0; i < families.length; i++) {
      const source = families[Math.floor(rand() * families.length)];
      const swapped = rand() < 0.5;
      for (const c of source) drawn.push({ ...copyOf(c, part, swapped), repo: c.repo, family: `draw${i}`, seed: c.seed });
    }
  }
  if (part === 'b') return SCORERS.repeat(drawn);
  const got = costSolvedT(drawn);
  return got.estimate === null ? null : { estimate: got.estimate, se: got.se, df: got.df };
}

/** The level of the H1 or H2 test at a chosen design: the share of true-zero runs whose p is below Holm's strictest 0.025,
 * per coding, under the seed rule at the bounds and at the point estimates, 3 and 2 fixed seeds, and 0/1 values. Stopped runs are left out of both counts.
 * `held` is true when every level is at most 2 simulation errors of its own run count above 0.025; a cell with no run fails.
 * @param {Record<string, any>} calPoint @param {Record<string, any>} calUpper
 * @param {{repos: number, families: number}} design @param {number} m
 * @param {{sims: number, seed: number, cap?: number, targetZ?: number, onMiss?: 'stop' | 'cap', label?: string}} opts */
export function levelCheck(calPoint, calUpper, design, m, opts) {
  const rule = { m, cap: opts.cap ?? SEED_CAP, targetZ: opts.targetZ ?? TARGET_Z, onMiss: opts.onMiss };
  const [three, two] = [{ ...design, seeds: SEEDS }, { ...design, seeds: 2 }];
  const cases = [
    ['rule at bounds', (rand) => analysed(repeatRun(calUpper, three, 0, rand, rule))],
    ['rule at point estimates', (rand) => analysed(repeatRun(calPoint, three, 0, rand, rule))],
    ['three seeds', (rand) => analysed(repeatRun(calPoint, three, 0, rand))],
    ['two seeds at bounds', (rand) => analysed(repeatRun(calUpper, two, 0, rand))],
    ['0/1 values', (rand) => analysed({ units: binaryRun(calUpper, three, rand), seeds: SEEDS, stopped: false })],
  ];
  const cells = cases.flatMap(([name, make]) => {
    const rand = seededRandom(cellSeed(opts.seed, 'level', opts.label ?? '', name, design.repos, design.families, m));
    const runs = Array.from({ length: opts.sims }, () => make(rand)).filter((r) => !r.stopped);
    // A rule cell keeps only the runs it let go, so its simulation error is from that count, not from sims.
    const ceiling = LEVEL + 2 * sd((LEVEL * (1 - LEVEL)) / runs.length);
    const stopShare = 1 - runs.length / opts.sims;
    return CODINGS.map((coding) => ({ name, coding, level: share(runs, (r) => r.est[coding].p < LEVEL), runs: runs.length, stopShare, ceiling }));
  });
  return { cells, held: cells.every((c) => c.level <= c.ceiling) };
}

// Per test (prereg :112): its codings, how a draw is scored, its 0/1 bases (the shift is its null) and the part its resampled case runs.
const LEVEL_TESTS = {
  T1: { codings: CODINGS, score: 'repeat', bases: [0.3] },
  T3: { codings: CODINGS, score: 'repeat', bases: [0.3] },
  T2c: { codings: CODINGS, score: 'repeat', bases: [0.3] },
  T2a: { codings: CODINGS.slice(0, 1), score: 'ratio', bases: [], part: 'a', onMiss: 'near' },
  T2b: { codings: CODINGS.slice(0, 1), score: 'repeat', bases: [0.9, 0.5], part: 'b' },
};
// A draw's p does not depend on the level, so one set of p values serves every threshold.
const ANY_LEVEL = 0.05;

// Each case is [setting, draw(rand)], a draw giving { coding: { estimate, se, df } | null }; `resampledCells` are the cells that case draws from.
function levelCases(spec, cfg, resampledCells) {
  const { calPoint, calUpper, layout } = spec;
  const { nullValue } = T_NULLS[spec.test];
  const counts = Array.from({ length: (spec.rule.cap ?? SEED_CAP) - SEEDS + 1 }, (_, i) => SEEDS + i);
  const run = (cal, seeds, rule) => (rand) => repeatRun(cal, { layout, seeds }, nullValue, rand, rule, { score: cfg.score, exact: true }).stat;
  const spreads = [['point', calPoint], ['upper', calUpper]];
  const binary = (base) => (rand) => {
    const units = binaryRun(calUpper, { layout, seeds: SEEDS }, rand, { base, shift: nullValue });
    return byCoding((c) => SCORERS.repeat(units[c]));
  };
  const resampled = (rand) => ({ [CODINGS[0]]: resampledRun(resampledCells, rand, cfg.part) });
  return [
    ...spreads.map(([at, cal]) => [`rule at ${at}`, run(cal, SEEDS, { ...spec.rule, onMiss: cfg.onMiss ?? 'cap' })]),
    ...spreads.flatMap(([at, cal]) => counts.map((n) => [`${n} seeds at ${at}`, run(cal, n, null)])),
    ...cfg.bases.map((base) => [`0/1 base ${base} at upper`, binary(base)]),
    ...(cfg.part === undefined ? [] : [['resampled', resampled]]),
  ];
}

const CALIBRATION_FIELDS = ['scale', 'loss', 'family', 'sequence', 'noise'];
const sameCoding = (cal) => CALIBRATION_FIELDS.every((f) => cal[CODINGS[0]][f] === cal[CODINGS[1]][f]);

// A Level check costs minutes per cell, so every input a run could fail on late or silently is refused before the first draw.
function checkedLevelSpec(spec, cfg) {
  checkedLayout(spec.layout, `levelCells ${spec.test}`);
  const resampled = (spec.resampled ?? []).filter((c) => c.seed <= SEEDS);
  const runsResampled = cfg.part !== undefined && (spec.cases === undefined || spec.cases.includes('resampled'));
  if (runsResampled && resampled.length === 0) throw new Error(`levelCells ${spec.test}: the resampled case needs spec.resampled cells with a seed of ${SEEDS} or less`);
  for (const name of ['calPoint', 'calUpper']) {
    const whole = CODINGS.every((c) => CALIBRATION_FIELDS.every((f) => Number.isFinite(spec[name]?.[c]?.[f])));
    if (!whole) throw new Error(`levelCells ${spec.test}: spec.${name} needs a calibration under both coding keys (${CODINGS.join(', ')}) with finite scale, loss, family, sequence and noise; a one-coding test passes one calibration under both keys`);
  }
  if (cfg.codings.length === 1 && !(sameCoding(spec.calPoint) && sameCoding(spec.calUpper))) throw new Error(`levelCells ${spec.test}: reads one coding, but a calibration gives its two codings different spreads, so the rule's count could change silently`);
  return resampled;
}

/** Every cell of prereg :112 for one test: the p values of `sims` draws per case and coding, each drawn at the test's null and scored by
 * `scoreTest` at its `T_NULLS` entry. A draw with no estimate counts as p = 1 and in `noEstimate`. `spec.cases` keeps only the named cases.
 * @param {{test: string, calPoint: object, calUpper: object, layout: {repo: string, k: number}[], rule: object, sims: number, seed: number, label?: string, resampled?: object[], cases?: string[]}} spec
 * @returns {{setting: string, ps: number[], noEstimate: number}[]} */
export function levelCells(spec) {
  const cfg = LEVEL_TESTS[spec.test];
  if (cfg === undefined) throw new Error(`levelCells: test ${spec.test} is not one of ${Object.keys(LEVEL_TESTS).join(', ')}`);
  const all = levelCases(spec, cfg, checkedLevelSpec(spec, cfg));
  const unknown = (spec.cases ?? []).filter((name) => !all.some(([known]) => known === name));
  if (unknown.length > 0) throw new Error(`levelCells ${spec.test}: no case named ${unknown.join(', ')}`);
  return all.filter(([name]) => spec.cases === undefined || spec.cases.includes(name)).flatMap(([name, draw]) => {
    const rand = seededRandom(cellSeed(spec.seed, 'level4', spec.label ?? '', spec.test, name));
    const cells = cfg.codings.map(() => ({ ps: [], noEstimate: 0 }));
    for (let i = 0; i < spec.sims; i++) {
      const stats = draw(rand);
      cfg.codings.forEach((coding, j) => {
        const p = stats?.[coding] ? scoreTest(stats[coding], { ...T_NULLS[spec.test], level: ANY_LEVEL }).p : Number.NaN;
        cells[j].ps.push(Number.isFinite(p) ? p : 1);
        if (!Number.isFinite(p)) cells[j].noEstimate++;
      });
    }
    return cfg.codings.map((coding, j) => ({ setting: cfg.codings.length > 1 ? `${name} (${coding})` : name, ...cells[j] }));
  });
}

/** The largest L = k / 1000 up to the threshold at which every cell's share of p below L is at most the threshold (0 when none), with each
 * size, error and noEstimate at L. `setBy` is the cell largest at L + 0.001 when L is under the threshold, else at L, with its size at L too.
 * @param {{setting: string, ps: number[], noEstimate: number}[]} cells @param {number} threshold */
export function levelSearch(cells, threshold) {
  const top = Math.round(threshold * 1000);
  if (top < 1 || Math.abs(threshold * 1000 - top) > 1e-6) throw new Error(`levelSearch: threshold ${threshold} is not a multiple of 0.001`);
  if (cells.length === 0 || cells.some((c) => c.ps.length === 0)) throw new Error('levelSearch: needs cells that each hold draws');
  if (cells.some((c) => !Number.isInteger(c.noEstimate))) throw new Error('levelSearch: every cell needs its noEstimate count');
  const blind = cells.find((c) => c.noEstimate >= c.ps.length);
  if (blind) throw new Error(`levelSearch: every draw of "${blind.setting}" has no estimate, so its size says nothing`);
  const sizeAt = (c, k) => share(c.ps, (p) => p < k / 1000);
  let k = top;
  while (k > 0 && cells.some((c) => sizeAt(c, k) > threshold)) k--;
  const probe = k / 1000 < threshold ? k + 1 : k;
  const view = (c, size) => ({ setting: c.setting, size, simError: sd((size * (1 - size)) / c.ps.length), noEstimate: c.noEstimate });
  const atLevel = cells.map((c) => view(c, sizeAt(c, k)));
  const blocking = cells.map((c) => sizeAt(c, probe));
  const worst = blocking.indexOf(Math.max(...blocking));
  const { size: sizeAtLevel, simError: simErrorAtLevel } = atLevel[worst];
  return { level: k / 1000, setBy: { ...view(cells[worst], blocking[worst]), at: probe / 1000, sizeAtLevel, simErrorAtLevel }, cells: atLevel };
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
