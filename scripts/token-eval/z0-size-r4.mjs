/** Z0 round 4 sizing (prereg items 3, 10 and 12): the calibrations, the per-test seed rules, the power read, the Level check and
 * `--check-levels`. z0-size.mjs and z0-seed-rule.mjs are the CLIs; this file holds what both read, so each rule has one home. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seededRandom } from '../../dist/eval/eval-stats.js';
import { ARM_TABLE, DESIGNS, designName, hasPair, isRound4Design, pairOf } from './arms.mjs';
import { sourceRows } from './z0-blind.mjs';
import { cellValues, costCells, partBValues } from './z0-cost-solved.mjs';
import { filterOpts, filteredInput, withoutRuns } from './z0-filters.mjs';
import { CODINGS, byCoding, codexApply, firstApplyR, inSets, mean, repeatMistakeUnits, sum, taskUnits } from './z0-hypotheses.mjs';
import { LEVELS_SCHEMA, SEED_CAP, parsePlan, positionKey } from './z0-records.mjs';
import { SEEDS, cellSeed, clopperPearsonUpper, harmSizer, levelCells, levelSearch, predictedSe, repeatRun, ruleSeeds, spreadComponents } from './z0-size-sim.mjs';
import { T_NULLS, THRESHOLDS, minLevels, scoreTest } from './z0-verdict-r4.mjs';

/** Prereg item 10: every round 4 draw uses this seed, through `cellSeed`. */
export const R4_SEED = 20_261_110;
export const HARM_TEST = 'H4';
const LEVEL_ENTRY = 'scripts/token-eval/z0-size.mjs';
const NO_UNITS = 'needs units in a repository with 2 families and 2 seeds';
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
const share = (xs, keep) => xs.filter(keep).length / xs.length;
// Levels step by 0.001, so 0.8 times a threshold can land a rounding error above the level that equals it.
const EPS = 1e-9;

/* ----------------------------------------------------------------------------------- calibrations (round 3's, moved here) */

/** Share of the arm pair's apply lessons marked not applicable on the first attempt. */
export function naRate(s, armT, armC, keep) {
  const lessons = s.filter((r) => (r.arm === armT || r.arm === armC) && r.kind === 'apply' && keep(r)).flatMap((r) => r.lessons);
  return lessons.length === 0 ? 0 : lessons.filter((l) => l.first === 'na').length / lessons.length;
}

/** H1 or H2 spreads per coding. The effect is defined on applicable checks, and `violation` counts na as a fail
 * in both arms, so it carries (1 - na rate) of the effect; `loss` is the share of units a coding drops. */
export function repeatCalibration(s, armT, armC, keep, bound) {
  const na = naRate(s, armT, armC, keep);
  const per = byCoding((coding) => {
    const { units, dropped } = repeatMistakeUnits(s, armT, armC, coding, keep);
    return { components: spreadComponents(units, bound), loss: dropped.length / Math.max(1, units.length + dropped.length) };
  });
  if (CODINGS.some((c) => per[c].components === null)) return { reason: `needs ${armT} and ${armC} units in a repository with 2 families and 2 seeds` };
  const scale = (c) => (c === 'violation' ? 1 - na : 1);
  const sim = byCoding((c) => ({ scale: scale(c), loss: per[c].loss, family: per[c].components.family, sequence: per[c].components.sequence, noise: per[c].components.noise }));
  const simUpper = byCoding((c) => ({ ...sim[c], ...per[c].components.upper }));
  return { naRate: na, ...per, sim, simUpper };
}

const sdOf = (xs) => Math.sqrt(xs.length < 2 ? 0 : sum(xs.map((x) => (x - mean(xs)) ** 2)) / (xs.length - 1));

/** Spread of log(A2 cost / A1 cost) by family, sequence and residual, and of the control's log cost, which weights the ratio. */
export function ratioCalibration(units, bound) {
  const priced = units.filter((u) => u.t.cost > 0 && u.c.cost > 0);
  const components = spreadComponents(priced.map((u) => ({ repo: u.repo, family: u.family, seed: u.seed, value: Math.log(u.t.cost / u.c.cost) })), bound);
  if (components === null) return { reason: 'needs priced A1 and A2 pairs in a repository with 2 tasks and 2 seeds' };
  const controlSd = sdOf(priced.map((u) => Math.log(u.c.cost)));
  return { components, controlSd, sim: { family: components.family, sequence: components.sequence, noise: components.noise, controlSd } };
}

/** Set N's spreads plus its resolve pairs. A true zero makes the two discordant cells equal, so each gets half the discordant
 * share, taken at its exact one-sided upper bound at `bound` (few pairs barely estimate it). */
export function harmCalibration(units, bound) {
  const cost = ratioCalibration(units, bound);
  if (cost.sim === undefined) return { reason: 'needs set N pairs in a repository with 2 tasks and 2 seeds' };
  const n = units.length;
  const both = units.filter((u) => u.t.resolved && u.c.resolved).length / n;
  const discordant = units.filter((u) => u.t.resolved !== u.c.resolved).length;
  const oneSide = clopperPearsonUpper(discordant, n, bound) / 2;
  return { ...cost, resolve: { pairs: n, discordant, both, oneSide, oneSideEstimate: discordant / n / 2 }, sim: { ...cost.sim, both, oneSide } };
}

/** The spreads each sized hypothesis needs, from the records the analyzer would score. H3 carries no verdict, so it sets no size. */
export function calibrate(filtered, prices, bound, opts = {}) {
  const s = filtered.scored;
  const design = opts.design ?? DESIGNS.r3;
  const [h1, h2, h4] = ['H1', 'H2', 'H4'].map((name) => (hasPair(design, name) ? pairOf(design, name) : null));
  const planned = (pair) => pair !== null && pair.every((a) => filtered.arms.includes(a));
  const notPlanned = (name, pair) => ({ reason: pair === null ? `design ${designName(design)} has no ${name}` : `${[...pair].sort().join(', ')} not in the calibration plan` });
  return {
    H1: planned(h1) ? repeatCalibration(s, ...h1, firstApplyR, bound) : notPlanned('H1', h1),
    H2: planned(h2) ? repeatCalibration(s, ...h2, codexApply, bound) : notPlanned('H2', h2),
    H4: planned(h4) ? harmCalibration(taskUnits(s, ...h4, prices, inSets('N'), opts), bound) : notPlanned('H4', h4),
  };
}

/** Set N's design from the units: the repositories present, and the mean distinct tasks per repository (units repeat per seed). */
export function harmDesign(units) {
  const tasks = new Map();
  for (const u of units) tasks.set(u.repo, (tasks.get(u.repo) ?? new Set()).add(u.family));
  const counts = [...tasks.values()].map((t) => t.size);
  return { repos: tasks.size, tasks: Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) };
}

/** H4 seeds: the fewest from SEEDS to the cap at which the harm gate passes with `power`, on the sizer's own calibration; null on a miss.
 * `opts.harmDesign` replaces the design the units give (round 4 batch 1 reads sit in the whole plan's).
 * @param {any} filtered @param {any} prices @param {any} opts */
export function harmSeeds(filtered, prices, opts) {
  const design = opts.design ?? DESIGNS.r3;
  const cal = calibrate(filtered, prices, opts.bound ?? opts.spreadBound, opts).H4;
  if (cal.sim === undefined) throw new Error(`${HARM_TEST}: ${cal.reason}`);
  const sized = opts.harmDesign ?? harmDesign(taskUnits(filtered.scored, ...pairOf(design, HARM_TEST), prices, inSets('N'), opts));
  for (let seeds = SEEDS; seeds <= (opts.cap ?? SEED_CAP); seeds++) {
    if (harmSizer(cal.sim, { sims: opts.sims, seed: opts.seed, seeds })(sized).pass >= opts.power) return seeds;
  }
  return null;
}

/** A design with a T1 is a round 4 design (`r4` or `r4-on-r3`); `isRound4Design` is true for the real `r4` alone.
 * @param {any} design */
export const isRoundFour = (design) => hasPair(design, 'T1');

/* ------------------------------------------------------------------------------------------------------ seed rules */

// Prereg item 10: T1, T3 and part (c) take m 0.15 at z 3.5; parts (a) and (b) take z 3.08, with m log(1 / 0.9) and 0.03.
const RULES = {
  T1: { m: 0.15, z: 3.5 }, T3: { m: 0.15, z: 3.5 }, T2c: { m: 0.15, z: 3.5 },
  T2a: { m: Math.log(1 / 0.9), z: 3.08, onMiss: 'near', near: 1.1 }, T2b: { m: 0.03, z: 3.08 },
};
const RULE_TESTS = ['T1', 'T2a', 'T2b', 'T2c', 'T3'];
function ruleOf(name) {
  const { m, z, onMiss = 'cap', near } = RULES[name];
  const rule = { m, cap: SEED_CAP, targetZ: z, onMiss };
  if (near !== undefined) rule.near = near;
  return rule;
}

/** One test's seed count from its first-wave unit lists (one per coding): the larger count of the lists. A miss runs a test at the cap,
 * and part (a) at the fewest seeds within 1.1 times its 9-seed error; `predictedSE` is the larger list's error at that count and at 9.
 * @param {string} name @param {{repo: string, family: string, seed: number, value: number}[][]} lists @param {{repo: string, k: number}[] | undefined} layout
 * @returns {{seeds: number, branch: 'rule' | 'miss' | 'cap', predictedSE: {atCount: number, at9: number}}} */
export function testSeeds(name, lists, layout) {
  if (!Object.hasOwn(RULES, name)) throw new Error(`testSeeds: ${name} is not one of ${Object.keys(RULES).join(', ')}`);
  const rule = ruleOf(name);
  const errors = lists.map((units) => {
    if (predictedSe(units, SEEDS, { layout }) === null) throw new Error(`${name}: ${NO_UNITS}`);
    return (n) => predictedSe(units, n, { layout });
  });
  const hit = lists.map((units) => ruleSeeds(units, { ...rule, onMiss: 'stop', layout }));
  const missed = hit.includes(null);
  const seeds = missed ? Math.max(...lists.map((units) => ruleSeeds(units, { ...rule, layout }))) : Math.max(...hit);
  const worst = (n) => Math.max(...errors.map((at) => at(n)));
  return { seeds, branch: !missed ? 'rule' : rule.onMiss === 'near' ? 'miss' : 'cap', predictedSE: { atCount: worst(seeds), at9: worst(SEED_CAP) } };
}

/** The reasons line of a test that left the rule. */
export const missReason = (name, r) => (r.branch === 'miss'
  ? `${name} needs more than ${SEED_CAP} seeds at its bar, so it runs at ${r.seeds} (within 1.1 times the ${SEED_CAP}-seed error)`
  : `${name} needs more than ${SEED_CAP} seeds, so it runs at the cap`);

/* ----------------------------------------------------------------------------------------------- layouts and readings */

const repoOf = (c) => c.repo ?? c.sequence;
const familyKey = (c) => c.familyId ?? `task ${c.taskId ?? c.position}`;
const byRepo = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/** Per repository, the distinct set R families and the distinct set N tasks of the plan cells whose arm is in `arms`. */
export function repoRows(cells, arms) {
  const repos = new Map();
  for (const c of cells) {
    if (!arms.includes(c.arm)) continue;
    const e = repos.get(repoOf(c)) ?? { families: new Set(), tasks: new Set() };
    if (c.set === 'R' && c.familyId !== null && c.familyId !== undefined) e.families.add(`${c.sequence}/${c.familyId}`);
    if (c.set === 'N') e.tasks.add(`${c.sequence}/${c.taskId ?? c.position}`);
    repos.set(repoOf(c), e);
  }
  return [...repos].sort(byRepo).map(([repo, e]) => ({ repo, families: e.families.size, tasks: e.tasks.size }));
}

/** Planned (repository, family or task, seed) cells where both arms of `pair` run one position, in `sets` (and of one `kind`, when given). */
export function plannedCells(cells, pair, sets, kind = undefined) {
  const at = new Map();
  for (const c of cells) {
    if (!pair.includes(c.arm) || !sets.includes(c.set) || (kind !== undefined && c.kind !== kind)) continue;
    const slot = at.get(positionKey(c)) ?? { c, arms: new Set() };
    at.set(positionKey(c), { c, arms: slot.arms.add(c.arm) });
  }
  return new Set([...at.values()].filter((s) => s.arms.size === pair.length).map(({ c }) => JSON.stringify([repoOf(c), familyKey(c), c.seed]))).size;
}

/** The share of planned cells with no cell, by counts. */
export const missingShare = (planned, present) => (planned === 0 ? 0 : Math.max(0, 1 - present / planned));

/** The repositories of a plan, for the layout message. @param {any[]} planCells */
export const repoCount = (planCells) => new Set(planCells.map(repoOf)).size;

/** The whole-plan files, each one repository's plan cells. @param {string[]} files @param {string} cwd @returns {{file: string, cells: any[]}[]} */
export function readWholePlans(files, cwd) {
  return files.map((file) => {
    const cells = parsePlan(fs.readFileSync(path.resolve(cwd, file), 'utf8'), file);
    const n = repoCount(cells);
    if (n !== 1) throw new Error(`--whole-plan ${file}: holds ${n} repositories, and a file is one repository`);
    return { file, cells };
  });
}

/** The whole-plan files' rows, one repository per file, named by position. @param {{file: string, cells: any[]}[]} wholePlans @param {string[]} arms */
function wholeRows(wholePlans, arms, dropped) {
  return wholePlans.flatMap(({ cells }, i) => repoRows(cells.filter((c) => !dropped.has(c.familyId)), arms).map((r) => ({ ...r, repo: `w${i + 1}` })));
}

const toUnits = (cells, values) => cells.map((c, i) => ({ repo: c.repo, family: c.family, seed: c.seed, value: values[i] }));
const fromParts = (components, loss) => {
  const sim = byCoding(() => ({ scale: 1, loss, family: components.family, sequence: components.sequence, noise: components.noise }));
  return { sim, simUpper: byCoding(() => ({ ...sim[CODINGS[0]], ...components.upper })) };
};

/** One cost or resolve part's reading: its units, calibration under both coding keys, and the share of planned cells it lacks. */
function partReading(name, part, scored, pair, prices, design, bound, cells) {
  const keep = inSets('R', 'N');
  let units;
  let resampled;
  if (part === 'a') {
    resampled = costCells(scored, pair, prices, keep, { design });
    units = toUnits(resampled, cellValues(resampled));
  } else {
    resampled = partBValues(scored, pair, keep);
    units = resampled.map((c) => ({ repo: c.repo, family: c.family, seed: c.seed, value: c.value }));
  }
  const components = units.length === 0 ? null : spreadComponents(units, bound);
  if (components === null) throw new Error(`${name}: ${NO_UNITS}`);
  return { units, resampled, ...fromParts(components, missingShare(plannedCells(cells, pair, ['R', 'N']), units.length)) };
}

/** Everything the round 4 modes read, built once from the records and the plan: per test its unit lists, calibration (point and upper),
 * layout and rule; the `T2aMiss` reading when the design has one; the counts the report heads. `opts` holds the filter keys, `spreadBound`,
 * and optionally `wholePlans` (`{file, cells}` per whole-plan file) and `noLayout` (a rule read with no layout: step 6).
 * @param {any[]} records @param {any[]} planCells @param {any} prices @param {any} opts @returns {any} */
export function prepareR4(records, planCells, prices, opts) {
  const design = opts.design;
  const bound = opts.spreadBound;
  const { filtered, abandoned, records: counted, planCells: cellsAll } = filteredInput(records, planCells, opts, { dropAbandoned: true });
  const dropped = new Set(filterOpts(opts).dropList?.droppedFamilies ?? []);
  const cells = withoutRuns(cellsAll, abandoned).filter((c) => !dropped.has(c.familyId));
  const wholePlans = opts.wholePlans ?? [];
  const pairs = Object.fromEntries([...RULE_TESTS, HARM_TEST].map((t) => [t, pairOf(design, t)]));
  for (const [t, pair] of Object.entries(pairs)) if (!pair.every((a) => filtered.arms.includes(a))) throw new Error(`${t}: ${pair.join(', ')} are not all in the plan`);
  const rowsOf = (pair) => (wholePlans.length > 0 ? wholeRows(wholePlans, pair, dropped) : repoRows(cells, pair));
  const layoutOf = (pair, tasks) => rowsOf(pair).map((r) => ({ repo: r.repo, k: r.families + (tasks ? r.tasks : 0) })).filter((e) => e.k >= 1);
  const scored = filtered.scored;
  const tests = {};
  for (const name of ['T1', 'T3', 'T2c']) {
    const pair = pairs[name];
    const keep = ARM_TABLE[pair[0]].tool === 'codex' ? codexApply : firstApplyR;
    const cal = repeatCalibration(scored, ...pair, keep, bound);
    if (cal.reason !== undefined) throw new Error(`${name}: ${cal.reason}`);
    tests[name] = { name, pair, cal, lists: CODINGS.map((c) => repeatMistakeUnits(scored, ...pair, c, keep).units), codings: CODINGS, score: 'repeat', layout: layoutOf(pair, false) };
  }
  const resampledPair = hasPair(design, 'resampled') ? pairOf(design, 'resampled') : null;
  for (const [name, part, score] of [['T2a', 'a', 'ratio'], ['T2b', 'b', 'repeat']]) {
    const r = partReading(name, part, scored, pairs[name], prices, design, bound, cells);
    const resampled = resampledPair === null ? undefined : (part === 'a' ? costCells(scored, resampledPair, prices, inSets('R', 'N'), { design }) : partBValues(scored, resampledPair, inSets('R', 'N')));
    tests[name] = { name, pair: pairs[name], cal: { sim: r.sim, simUpper: r.simUpper }, lists: [r.units], codings: CODINGS.slice(0, 1), score, layout: layoutOf(pairs[name], true), resampled, part };
  }
  const harm = calibrate(filtered, prices, bound, { design }).H4;
  if (harm.sim === undefined) throw new Error(`${HARM_TEST}: ${harm.reason}`);
  // Round 4 sizes set N at the whole plan's repositories and mean tasks; round 3's read sizes it at the units' own.
  const harmRows = rowsOf(pairs.H4).filter((r) => r.tasks > 0);
  const harmUnits = () => harmDesign(taskUnits(scored, ...pairs.H4, prices, inSets('N'), { design }));
  tests.H4 = { name: HARM_TEST, pair: pairs.H4, cal: harm, lists: [], design: isRound4Design(design) && harmRows.length > 0 ? { repos: harmRows.length, tasks: Math.round(mean(harmRows.map((r) => r.tasks))) } : harmUnits() };
  return {
    design, bound, filtered, prices, scored, tests, wholeRun: wholePlans.length > 0,
    ruleLayout: isRound4Design(design) && opts.noLayout !== true, miss: missReading(records, planCells, prices, opts, bound),
    usable: withoutRuns(counted, abandoned), records: counted.length, abandoned: [...abandoned.values()].sort(), repos: tests.T1.layout.length,
  };
}

/** Part (a)'s reading on the `T2aMiss` pair with every family kept, as `r3-parta-se.mjs` reads it (the design's drops would remove the miss). */
function missReading(records, planCells, prices, opts, bound) {
  const design = opts.design;
  if (!hasPair(design, 'T2aMiss')) return null;
  const pair = pairOf(design, 'T2aMiss');
  const every = { ...opts, design: { ...design, dropFamilies: [] } };
  if (opts.dropList) every.dropList = { ...opts.dropList, droppedFamilies: [] };
  const all = filteredInput(records, planCells, every, { dropAbandoned: true });
  const cells = withoutRuns(all.planCells, all.abandoned);
  const r = partReading('T2aMiss', 'a', all.filtered.scored, pair, prices, design, bound, cells);
  const rows = repoRows(cells, pair);
  return { pair, units: r.units, cal: { sim: r.sim, simUpper: r.simUpper }, layout: rows.map((x) => ({ repo: x.repo, k: x.families + x.tasks })).filter((e) => e.k >= 1) };
}

/* --------------------------------------------------------------------------------------------------- counts and sizer */

/** Each test's count and branch: T1, T2a, T2b, T2c, T3 by `testSeeds`, and H4 by `harmSeeds`; the layout only under the real design's reads. */
export function ruleCounts(p, opts) {
  const perTest = {};
  for (const name of RULE_TESTS) perTest[name] = testSeeds(name, p.tests[name].lists, p.ruleLayout ? p.tests[name].layout : undefined);
  const harm = harmSeeds(p.filtered, p.prices, { ...opts, seed: R4_SEED, bound: p.bound, cap: SEED_CAP, harmDesign: p.tests.H4.design });
  perTest[HARM_TEST] = { seeds: harm ?? SEED_CAP, branch: harm === null ? 'cap' : 'rule', predictedSE: null };
  return perTest;
}

/** Set N's harm gate pass share at `seeds`. @param {any} p @param {number} seeds @param {number} sims */
const harmPower = (p, seeds, sims) => harmSizer(p.tests.H4.cal.sim, { sims, seed: R4_SEED, seeds })(p.tests.H4.design).pass;

/** Group arms at their group's largest count and every other arm at its base seeds; a later group runs only when all its arms are planned. */
function countsOf(p, perTest) {
  const groups = p.design.seedRule.filter((g, i) => i === 0 || g.arms.every((a) => p.filtered.arms.includes(a)));
  const seeds = Object.fromEntries(groups.flatMap((g) => g.arms.map((a) => [a, Math.max(...g.tests.map((t) => perTest[t].seeds))])));
  return { seeds, countsByArm: Object.fromEntries(p.design.arms.map((a) => [a, seeds[a] ?? ARM_TABLE[a].seeds])) };
}

/** The level a test is read at: the file's, else its nominal first threshold. @param {Record<string, any> | null} levels @param {string} name */
export const levelOf = (levels, name) => levels?.[name]?.[THRESHOLDS[name][0]]?.level ?? Number(THRESHOLDS[name][0]);

/** The effect of a test's power read, `exact` when every cell sits at it. T2a is log(0.5 r), part (b) and (c) are 0. */
function effectFor(name, costRatio) {
  if (name === 'T1' || name === 'T3') return { effect: -0.15, exact: false };
  return { effect: name === 'T2a' ? Math.log(0.5 * costRatio) : 0, exact: true };
}

/** Power of one test: `sims` draws at `effect`, each scored by `scoreTest` at the test's null and `level`; the rule runs in each draw, or `seeds` are fixed.
 * @returns {{level: number, sims: number, perCoding: Record<string, number>, joint: number, frechet: number | null, simError: number}} */
function figureOf(reading, name, { sims, level, read, effect, exact, seeds }) {
  const rand = seededRandom(cellSeed(R4_SEED, 'power', name, read));
  const [rule, layout] = [seeds === undefined ? ruleOf(name) : null, reading.layout];
  const wins = reading.codings.map(() => 0);
  let joint = 0;
  for (let i = 0; i < sims; i++) {
    const { stat } = repeatRun(reading.cal.sim, { layout, seeds }, effect, rand, rule, { score: reading.score, exact });
    const won = reading.codings.map((c) => (stat?.[c] ? scoreTest(stat[c], { ...T_NULLS[name], level }).win : false));
    won.forEach((w, j) => { wins[j] += Number(w); });
    joint += Number(won.every(Boolean));
  }
  const perCoding = Object.fromEntries(reading.codings.map((c, j) => [c, wins[j] / sims]));
  return { level, sims, perCoding, joint: joint / sims, frechet: reading.codings.length === 2 ? sum(Object.values(perCoding)) - 1 : null, simError: Math.sqrt((joint / sims) * (1 - joint / sims) / sims) };
}

/** The power figures of a read: T1 and T3 under the rule; T2's parts under the rule, or at 3, 3 and 5 seeds when `wholeRun`; part (a) only with a cost ratio.
 * A second T2 read puts part (b) at -0.01. @param {any} p @param {{sims: number, levels: Record<string, any> | null, costRatio: number | null, wholeRun: boolean, second: boolean}} o @returns {any} */
export function powerFigures(p, o) {
  const t0 = Date.now();
  const fixed = { T2a: 3, T2b: 3, T2c: 5 };
  const one = (name, extra = {}) => figureOf(p.tests[name], name, { sims: o.sims, level: levelOf(o.levels, name), read: 'first', ...effectFor(name, o.costRatio), seeds: o.wholeRun ? fixed[name] : undefined, ...extra });
  const figs = { T1: one('T1'), T3: one('T3'), T2a: o.costRatio === null ? null : one('T2a'), T2b: one('T2b'), T2c: one('T2c') };
  const second = o.second ? one('T2b', { read: 'second', effect: -0.01 }) : null;
  const four = figs.T2a === null ? null : figs.T1.joint + figs.T2a.joint + figs.T2b.joint + figs.T2c.joint - 3;
  const count = Object.values(figs).filter((f) => f !== null).length + (second === null ? 0 : 1);
  return { figs, second, bounds: { four, two: figs.T1.joint + figs.T3.joint - 1 }, ms: Math.round((Date.now() - t0) / count / (o.sims / 1000)), partAEffect: o.costRatio === null ? null : Math.log(0.5 * o.costRatio) };
}

/** Exit 3 and `STOP: T1 power <p>` when T1's figure is under 0.8; else exit 4 and a `FOUNDER` line for each of T3 and the T2 parts under it; a null figure is skipped.
 * @param {Record<string, number | null>} figures @returns {{code: number, lines: string[]}} */
export function powerStop(figures) {
  const low = (t) => Number.isFinite(figures[t]) && figures[t] < 0.8;
  if (low('T1')) return { code: 3, lines: [`STOP: T1 power ${f3(figures.T1)}`] };
  const lines = ['T3', 'T2a', 'T2b', 'T2c'].filter(low).map((t) => `FOUNDER: ${t} power ${f3(figures[t])}: go on or stop`);
  return { code: lines.length > 0 ? 4 : 0, lines };
}

const figureLine = (prefix, f) => {
  const ci = `(+/- ${f3(f.simError)})`;
  const [head, tail] = [`${prefix} at level ${f3(f.level)}`, `; figure ${f3(f.joint)}`];
  if (f.frechet === null) return `${head}: ${f3(f.joint)} ${ci}${tail}`;
  return `${head}: ${Object.entries(f.perCoding).map(([c, v]) => `${c} ${f3(v)}`).join(', ')}, both ${f3(f.joint)} ${ci}, P(one) + P(other) - 1 ${f3(f.frechet)}${tail}`;
};

/** The lines of a power read, in the plan's order; `beside` prints under T3 and `spend` under the bounds. Round 3's whole-run T2 read has no stop.
 * @param {any} read @param {{wholeRun: boolean, beside: string | null, spend: string | null}} o @returns {{lines: string[], code: number}} */
export function powerLines(read, o) {
  const { figs, second, bounds } = read;
  const T2 = ['T2a', 'T2b', 'T2c'];
  const lines = [figureLine('T1 power', figs.T1), figureLine('T3 power', figs.T3), ...(o.beside === null ? [] : [o.beside]), ...(o.wholeRun ? ["assumption: round 3's same-model spreads (prereg item 12)"] : [])];
  for (const t of T2) lines.push(figs[t] === null ? `${t} power n/a: needs --cost-ratio` : figureLine(o.wholeRun ? `${t} at ${t === 'T2c' ? 5 : 3} seeds: power` : `${t} power`, figs[t]));
  if (second !== null) lines.push(figureLine('T2 second read, T2b at -0.01: power', second));
  lines.push(`bound T1 + T2a + T2b + T2c - 3: ${bounds.four === null ? 'n/a: needs --cost-ratio' : f3(bounds.four)}`, `bound T1 + T3 - 1: ${f3(bounds.two)}`);
  if (o.spend !== null) lines.push(o.spend);
  const stop = o.wholeRun ? { code: 0, lines: [] } : powerStop(Object.fromEntries(['T1', 'T3', ...T2].map((t) => [t, figs[t] === null ? null : Number(f3(figs[t].joint))])));
  return { lines: [...lines, ...stop.lines, `POWER MS ${read.ms}`], code: stop.code };
}

/** The seed rule of a round 4 design: each test's count, group arms at their largest, `countsByArm`, and the power of a test that left the rule (prereg item 10).
 * Under `r4` it needs `opts.costRatio` and `opts.levels` (a `minLevels` map); under `r4-on-r3` both are optional and the power reads the nominal level.
 * @param {any[]} records @param {any[]} planCells @param {any} prices @param {any} opts @returns {any} */
export function seedRuleR4(records, planCells, prices, opts) {
  const design = opts.design;
  if (opts.onMiss === 'stop') throw new Error('--on-miss stop: a miss runs at the cap (prereg item 10)');
  const real = isRound4Design(design);
  if (real && !(Number.isFinite(opts.costRatio) && opts.levels)) throw new Error('seedRule: round 4 needs opts.costRatio and opts.levels, the power of a test that misses the rule');
  const p = prepareR4(records, planCells, prices, { ...opts, spreadBound: opts.bound, noLayout: true });
  if (p.scored.some((r) => r.seed > SEEDS)) throw new Error(`the rule reads wave 1 only: a scored record has a seed above ${SEEDS}`);
  const perTest = ruleCounts(p, opts);
  const levels = opts.levels ?? null;
  const costRatio = Number.isFinite(opts.costRatio) ? opts.costRatio : null;
  for (const [name, r] of Object.entries(perTest)) {
    let power = null;
    if (r.branch !== 'rule' && name === HARM_TEST) power = harmPower(p, r.seeds, opts.sims);
    else if (r.branch !== 'rule' && (name !== 'T2a' || costRatio !== null)) power = figureOf(p.tests[name], name, { sims: opts.sims, level: levelOf(levels, name), read: 'seed rule', ...effectFor(name, costRatio) }).joint;
    Object.assign(r, { power, powerLevel: levels === null ? 'nominal' : 'levels' });
  }
  return { design: designName(design), perTest, ...countsOf(p, perTest), reasons: Object.entries(perTest).filter(([, r]) => r.branch !== 'rule').map(([n, r]) => missReason(n, r)), stop: false };
}

/** The default round 4 sizer: each test's count and predicted errors, its power at `levels` (or nominal), the two bounds and the `T2aMiss` reading.
 * @param {any} p @param {any} opts @returns {any} */
export function sizeR4(p, opts) {
  const tests = ruleCounts(p, opts);
  const read = powerFigures(p, { sims: opts.sims, levels: opts.levels ?? null, costRatio: opts.costRatio ?? null, wholeRun: false, second: false });
  for (const [name, r] of Object.entries(tests)) {
    const fig = read.figs[name];
    r.power = fig === undefined ? harmPower(p, r.seeds, opts.sims) : fig?.joint ?? null;
  }
  let miss = null;
  if (p.miss !== null) {
    const got = testSeeds('T2a', [p.miss.units], undefined);
    miss = { ...got, errorAt3: predictedSe(p.miss.units, SEEDS), errorAt9: got.predictedSE.at9, bar: RULES.T2a.m / RULES.T2a.z };
  }
  return { tests, miss, bounds: read.bounds, powerMs: read.ms };
}

/** The lines of the default sizer. @param {any} sized */
export function sizeLines(sized) {
  const lines = [];
  const { tests } = sized;
  for (const name of ['T1', 'T2a', 'T2b', 'T2c', 'T3', 'H4']) {
    const r = tests[name];
    const power = r.power === null ? 'power n/a: needs --cost-ratio' : `power ${f3(r.power)}`;
    const errors = r.predictedSE === null ? '' : `, error at ${r.seeds} seeds ${f4(r.predictedSE.atCount)}, at ${SEED_CAP} seeds ${f4(r.predictedSE.at9)}`;
    lines.push(`${name} seeds ${r.seeds} (${r.branch})${errors}; ${power}`);
  }
  const m = sized.miss;
  if (m !== null) lines.push(`T2aMiss error at 3 seeds ${f4(m.errorAt3)}, at ${SEED_CAP} seeds ${f4(m.errorAt9)}, bar ${f4(m.bar)}; seeds ${m.seeds} (${m.branch})`);
  lines.push(`bound T1 + T2a + T2b + T2c - 3: ${sized.bounds.four === null ? 'n/a: needs --cost-ratio' : f3(sized.bounds.four)}`, `bound T1 + T3 - 1: ${f3(sized.bounds.two)}`);
  return lines;
}

/** The counts batch 1's rules imply at the whole plan's layout, for `admit --step batch-2`: group arms at their largest, the rest at their base seeds.
 * @param {any} p @param {any} opts @returns {{countsByArm: Record<string, number>, count: number}} */
export function previewR4(p, opts) {
  const { seeds, countsByArm } = countsOf(p, ruleCounts(p, opts));
  return { countsByArm, count: Math.max(...Object.values(seeds)) };
}

/* ------------------------------------------------------------------------------------------------------ Level check */

const caseOf = (setting) => setting.replace(/ \((violation|excluded)\)$/, '');

/** The cell groups of a test: its own, and under `r4-on-r3` part (a)'s rule cells on the `T2aMiss` pair with every family. */
function levelGroups(p, name) {
  const r = p.tests[name];
  const spec = { test: name, calPoint: r.cal.sim, calUpper: r.cal.simUpper, layout: r.layout, rule: ruleOf(name), seed: R4_SEED, label: `${name} ${r.pair.join('/')}` };
  if (r.resampled !== undefined) spec.resampled = r.resampled;
  const groups = [{ spec, suffix: '' }];
  if (name === 'T2a' && p.miss !== null) {
    const pair = p.miss.pair.join('/');
    groups.push({ spec: { ...spec, calPoint: p.miss.cal.sim, calUpper: p.miss.cal.simUpper, layout: p.miss.layout, label: `T2aMiss ${pair}`, cases: ['rule at point', 'rule at upper'] }, suffix: ` [${pair}]` });
  }
  return groups;
}

/** The Level check of every test (prereg :112): cells from `levelCells`, levels from `levelSearch` at each threshold, a rerun at 5 times the draws of every cell
 * over the threshold at the floor (0.8 times it), and a flag when a level stays under the floor. `cellsFor` is a seam for a planted cell source.
 * @param {any} p @param {{levelSims: number, source: string, commit: string | null, inputs: any[], pre?: any}} opts @param {(spec: any) => any[]} [cellsFor]
 * @returns {{file: any, lines: string[], code: number}} */
export function levelCheckR4(p, opts, cellsFor = levelCells) {
  const sources = sourceRows(LEVEL_ENTRY);
  if (opts.pre !== undefined) {
    if (opts.source !== 'batch-1') throw new Error('--pre-levels belongs to a batch-1 Level check, which reads the pre-freeze file beside its own');
    minLevels(opts.pre, { schema: LEVELS_SCHEMA, source: 'batch-1', commit: opts.pre.commit, sources, levels: opts.pre.levels }, () => {});
  }
  const t0 = Date.now();
  const lines = [`commit ${opts.commit ?? 'not recorded: git rev-parse HEAD failed'}`];
  const [levels, floorFlags] = [{}, []];
  let drawn = 0;
  for (const name of Object.keys(THRESHOLDS)) {
    const groups = levelGroups(p, name);
    const run = (gi, sims, label, cases) => cellsFor({ ...groups[gi].spec, sims, label, cases })
      .map((c) => { drawn += c.ps.length; return { ...c, group: gi, caseName: caseOf(c.setting), setting: c.setting + groups[gi].suffix }; });
    let cells = groups.flatMap((g, gi) => run(gi, opts.levelSims, g.spec.label, g.spec.cases));
    levels[name] = {};
    for (const t of THRESHOLDS[name]) {
      const [threshold, floor] = [Number(t), 0.8 * Number(t) - EPS];
      let found = levelSearch(cells, threshold);
      const over = cells.filter((c) => c.ps.length < 5 * opts.levelSims && share(c.ps, (x) => x < floor) > threshold);
      if (found.level < floor && over.length > 0) {
        for (const [gi, g] of groups.entries()) {
          const names = [...new Set(over.filter((c) => c.group === gi).map((c) => c.caseName))];
          if (names.length === 0) continue;
          const fresh = run(gi, 5 * opts.levelSims, `${g.spec.label} floor`, names);
          cells = [...cells.filter((c) => !(c.group === gi && names.includes(c.caseName))), ...fresh];
        }
        found = levelSearch(cells, threshold);
      }
      const largest = Math.max(...found.cells.map((c) => c.size));
      levels[name][t] = { level: found.level, setBy: found.setBy.setting, sizeAtLevel: found.setBy.sizeAtLevel, simErrorAtLevel: found.setBy.simErrorAtLevel, largestAtLevel: largest, cells: found.cells };
      lines.push(`${name} ${t}: level ${f3(found.level)}, set by ${found.setBy.setting}, size at level ${f3(found.setBy.sizeAtLevel)} (+/- ${f3(found.setBy.simErrorAtLevel)}), largest at level ${f3(largest)}, most no-estimate draws in a cell ${Math.max(...cells.map((c) => c.noEstimate))} of ${opts.levelSims}`);
      if (opts.pre !== undefined) {
        const was = opts.pre.levels[name][t].level;
        lines.push(`${name} ${t} levels: pre-freeze ${f3(was)}, ${opts.source} ${f3(found.level)}, lower ${f3(Math.min(was, found.level))}`);
      }
      if (found.level < floor) {
        const draws = cells.find((c) => c.setting === found.setBy.setting).ps.length;
        floorFlags.push({ test: name, threshold: t, level: found.level, setBy: found.setBy.setting, draws });
        lines.push(`BROKEN DESIGN: ${name} ${t}`);
      }
    }
  }
  lines.push(`LEVEL MS ${Math.round((Date.now() - t0) / (drawn / 1000))}`);
  const file = { schema: LEVELS_SCHEMA, source: opts.source, draws: opts.levelSims, commit: opts.commit, sources, inputs: opts.inputs, levels, floorFlags };
  return { file, lines, code: floorFlags.length > 0 ? 3 : 0 };
}

/** The `--levels` count of a round 4 read: two files under `r4`, which a read that needs none may also leave out; at most one under `r4-on-r3`.
 * @param {string} name the design's name @param {number} n @param {boolean} required */
export function checkLevelFlags(name, n, required) {
  if (name === 'r4' ? n === 2 || (n === 0 && !required) : n <= 1) return;
  throw new Error(name === 'r4' ? `--levels: round 4 reads two levels files, the pre-freeze one and the batch-1 one (prereg Level check); got ${n}` : `--levels: ${name} reads at most one levels file, got ${n}`);
}

/** `git rev-parse HEAD` of the checkout this file sits in, or null. */
export function headCommit() {
  const got = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', windowsHide: true });
  return got.status === 0 ? got.stdout.trim() : null;
}

/** Levels files read from disk, each with its `file` path; a file that is not a levels file stops with its name. @param {string[]} files @param {string} cwd @returns {any[]} */
export function readLevelFiles(files, cwd) {
  return files.map((f) => {
    let body;
    try {
      body = JSON.parse(fs.readFileSync(path.resolve(cwd, f), 'utf8'));
    } catch (e) {
      throw new Error(`${f}: not a readable JSON file (${e.message})`);
    }
    if (body?.schema !== LEVELS_SCHEMA) throw new Error(`${f}: schema is ${body?.schema}, not ${LEVELS_SCHEMA}`);
    return { ...body, file: f };
  });
}

/** The levels a read uses: under `r4` the lower of the pre-freeze and batch-1 files, else the one file's; null with no file.
 * @param {any} design @param {any[]} loaded @param {(m: string) => void} log */
export function levelsFor(design, loaded, log) {
  if (loaded.length === 0) return null;
  if (!isRound4Design(design)) return loaded[0].levels;
  const [pre, batch1] = loaded[0].source === 'batch-1' ? [loaded[1], loaded[0]] : [loaded[0], loaded[1]];
  return minLevels(pre, batch1, log);
}

/** `--check-levels`: the file's sources against this checkout's, by path and sha256. @param {string} file @param {string} cwd @returns {{code: number, lines: string[]}} */
export function checkLevels(file, cwd) {
  const [body] = readLevelFiles([file], cwd);
  const have = new Map(sourceRows(LEVEL_ENTRY).map((r) => [r.file, r.sha256]));
  const was = new Map(body.sources.map((r) => [r.file, r.sha256]));
  const fails = [...new Set([...have.keys(), ...was.keys()])].sort().flatMap((f) => {
    const how = !was.has(f) ? 'added' : !have.has(f) ? 'missing' : have.get(f) !== was.get(f) ? 'changed' : null;
    return how === null ? [] : [`CHECK LEVELS FAIL: ${file}: ${f} ${how}`];
  });
  return fails.length > 0 ? { code: 3, lines: fails } : { code: 0, lines: [`CHECK LEVELS PASS: ${was.size} sources`] };
}

/** Round 3's attribution figures from line 27 of its unblinded report, by pattern, as the power read prints them beside T3. */
export function r3Attribution(file, cwd) {
  const line = fs.readFileSync(path.resolve(cwd, file), 'utf8').split(/\r?\n/)[26] ?? '';
  const got = /\b\w+ vs \w+ violation -?\d+\.\d+ \[-?\d+\.\d+, -?\d+\.\d+\]/.exec(line);
  if (got === null) throw new Error(`${file}: line 27 holds no "<x> vs <y> violation <e> [<lo>, <hi>]" figure; --r3-unblind reads round 3's attribution line`);
  return `T3 round 3 ${file} line 27: ${got[0]}`;
}
