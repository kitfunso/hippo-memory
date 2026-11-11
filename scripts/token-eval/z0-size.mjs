#!/usr/bin/env node
/** Z0 sizing, part 2 of 2 (stage 2 step S5, D6): reads calibration records, estimates the spreads and not-applicable rates,
 * searches a repositories-by-families grid for the sizes prereg 209-215 asks for, and prices sessions and days of plan usage.
 * Writes JSON to stdout, or to --out with a one-line summary per effect on stdout. Exit 0 on a report, 1 on bad input. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARM_TABLE, DESIGNS, TWO_SEED_ARMS, designByName, isRound4Design } from './arms.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { loadInputs } from './z0-analyze.mjs';
import { runBlock } from './z0-batch1-block.mjs';
import { inputHashes } from './z0-blind.mjs';
import { projectSpend, readBasis } from './z0-budget.mjs';
import { filterOpts, filteredInput, withoutRuns } from './z0-filters.mjs';
import { mean } from './z0-hypotheses.mjs';
import { readMergeManifest } from './z0-merge.mjs';
import { costOf } from './z0-prices.mjs';
import { readReadSet } from './z0-read-set.mjs';
import { SEED_CAP, SEED_PREVIEW_SCHEMA, isString } from './z0-records.mjs';
import {
  R4_SEED, calibrate, checkLevelFlags, checkLevels, headCommit, isRoundFour, levelCheckR4, levelsFor, powerFigures, powerLines, prepareR4, previewR4, r3Attribution, readLevelFiles, readWholePlans,
  repoCount, sizeLines, sizeR4,
} from './z0-size-r4.mjs';
import { SEEDS, confirmSize, harmSizer, levelCheck, repeatSizer, smallestPassing } from './z0-size-sim.mjs';

export { BLOCK_SCHEMA } from './z0-batch1-block.mjs';
export { HARM_TEST, calibrate } from './z0-size-r4.mjs';

const TOOLS = ['claude-code', 'codex'];
// SHORTCUT: placeholder quotas in list-price dollars a day, not measured; S9 passes the screen's measured usage per plan window (D7).
export const QUOTA_USD_PER_DAY = { 'claude-code': 300, codex: 100 };
export const DEFAULTS = {
  repos: [5, 8, 10, 12, 15, 20], effects: [0.15, 0.2, 0.25], power: 0.8, sims: 2_000, seed: 1,
  searchSims: 200, maxFamilies: 60, maxFamiliesPerRepo: 4, maxNTasks: 600, spreadBound: 0.8,
  seedCap: SEED_CAP, targetZ: 3.5, onMiss: 'cap', levelSims: 20_000,
};
const ENTRY = 'scripts/token-eval/z0-size.mjs';
const USAGE = 'usage: z0-size.mjs --runs FILE [--runs FILE ...] --plan FILE [--plan FILE ...] --prices FILE [--grading FILE] [--drop-list FILE] [--off-pin FILE ...] '
  + '[--repos 5,8,10,12,15,20] [--effects 0.15,0.2,0.25] [--power 0.8] [--sims 2000] [--seed 1] '
  + '[--search-sims 200] [--max-families 60] [--max-families-per-repo 4] [--max-n-tasks 600] [--spread-bound 0.8] '
  + '[--seed-cap 9] [--target-z 3.5] [--on-miss stop|cap] [--level-sims 20000] '
  + '[--claude-usd-per-day 300] [--codex-usd-per-day 100] [--out FILE]\n'
  + 'round 4: [--design r3|r4|r4-on-r3] [--read-set FILE] [--whole-plan FILE ...] [--levels FILE ...] [--pre-levels FILE] [--cost-ratio R] [--spend-basis FILE] [--r3-unblind FILE] [--key FILE] '
  + '[--power | --level-check | --batch1-block | --seed-rule-preview | --check-levels FILE]';

const integer = (flag, min) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer of at least ${min}, got ${v}`);
  return n;
};
const fraction = (flag) => (v) => {
  const n = Number(v);
  if (!(n > 0 && n < 1)) throw new Error(`${flag} must be between 0 and 1, got ${v}`);
  return n;
};
const positive = (flag) => (v) => {
  const n = Number(v);
  if (!(Number.isFinite(n) && n > 0)) throw new Error(`${flag} must be a positive number, got ${v}`);
  return n;
};
const oneOf = (flag, values) => (v) => {
  if (!values.includes(v)) throw new Error(`${flag} must be one of ${values.join(', ')}, got ${v}`);
  return v;
};
const designArg = (v) => {
  designByName(v);
  return v;
};
const REPEATED = new Map([['--runs', 'runs'], ['--plan', 'plan'], ['--off-pin', 'offPin'], ['--whole-plan', 'wholePlan'], ['--levels', 'levels']]);
const list = (parse) => (v) => v.split(',').map(parse);
const FLAGS = new Map([
  ['--prices', ['prices', String]], ['--grading', ['grading', String]], ['--drop-list', ['dropList', String]], ['--out', ['out', String]],
  ['--repos', ['repos', list(integer('--repos', 2))]], ['--effects', ['effects', list(fraction('--effects'))]],
  ['--power', ['power', fraction('--power')]], ['--sims', ['sims', integer('--sims', 1)]],
  ['--seed', ['seed', integer('--seed', 1)]], ['--search-sims', ['searchSims', integer('--search-sims', 1)]],
  ['--max-families', ['maxFamilies', integer('--max-families', 1)]],
  ['--max-families-per-repo', ['maxFamiliesPerRepo', integer('--max-families-per-repo', 2)]],
  ['--max-n-tasks', ['maxNTasks', integer('--max-n-tasks', 1)]], ['--spread-bound', ['spreadBound', fraction('--spread-bound')]],
  ['--seed-cap', ['seedCap', integer('--seed-cap', 3)]], ['--target-z', ['targetZ', positive('--target-z')]],
  ['--on-miss', ['onMiss', oneOf('--on-miss', ['stop', 'cap'])]],
  ['--level-sims', ['levelSims', integer('--level-sims', 1)]],
  ['--claude-usd-per-day', ['claudeQuota', positive('--claude-usd-per-day')]], ['--codex-usd-per-day', ['codexQuota', positive('--codex-usd-per-day')]],
  ['--design', ['design', designArg]], ['--read-set', ['readSet', String]], ['--pre-levels', ['preLevels', String]],
  ['--cost-ratio', ['costRatio', positive('--cost-ratio')]], ['--spend-basis', ['spendBasis', String]], ['--r3-unblind', ['r3Unblind', String]], ['--key', ['key', String]],
]);
// A mode takes no value, except --power, which keeps round 3's valued form when a value follows; --check-levels takes its file.
const MODES = new Map([['--power', 'power'], ['--level-check', 'level-check'], ['--batch1-block', 'batch1-block'], ['--seed-rule-preview', 'seed-rule-preview'], ['--check-levels', 'check-levels']]);
const BARE = new Set(['--level-check', '--batch1-block', '--seed-rule-preview']);
const ROUND_FOUR_FLAGS = new Set(['--whole-plan', '--levels', '--read-set', '--pre-levels', '--cost-ratio', '--spend-basis', '--r3-unblind', '--key']);
const FLAG_OF = { costRatio: '--cost-ratio', out: '--out', key: '--key' };
const NEEDS = { power: ['costRatio'], 'level-check': ['out'], 'seed-rule-preview': ['out'], 'batch1-block': ['key', 'out'] };

/** The round 4 rules of a parsed argv: round 3 takes none of its flags or modes, one mode runs, and each mode names the flags it needs. */
function checkRoundFour(args, { given, used, modes }) {
  const design = designByName(args.design);
  if (!isRoundFour(design) && used.length > 0) throw new Error(`${used[0]}: round 4 only`);
  if (modes.length > 1) throw new Error(`one mode at a time: ${modes.join(', ')}`);
  args.mode = modes.length === 0 ? null : MODES.get(modes[0]);
  if (isRoundFour(design) && given.has('--seed')) throw new Error(`round 4 draws use seed ${R4_SEED} (prereg item 10)`);
  if (args.mode === 'check-levels') return;
  if (args.readSet === null && (args.runs.length === 0 || args.plan.length === 0)) throw new Error(USAGE);
  for (const k of NEEDS[args.mode] ?? []) if (args[k] === null) throw new Error(`${modes[0]} needs ${FLAG_OF[k]}`);
  if (args.preLevels !== null && args.mode !== 'level-check') throw new Error('--pre-levels needs --level-check');
  if (args.mode === 'batch1-block' && !isRound4Design(design)) throw new Error('--batch1-block: design r4 only');
  if (isRoundFour(design) && (args.mode === 'power' || args.mode === null)) checkLevelFlags(args.design, args.levels.length, args.mode === 'power');
}

/** @param {string[]} argv @returns {any} */
export function parseArgs(argv) {
  const args = {
    runs: [], plan: [], offPin: [], wholePlan: [], levels: [], mergeManifest: [], prices: null, dropList: null, grading: null, out: null, claudeQuota: null, codexQuota: null,
    design: 'r3', readSet: null, preLevels: null, costRatio: null, spendBasis: null, r3Unblind: null, key: null, mode: null, checkLevels: null, help: false, ...DEFAULTS,
  };
  const [given, used, modes] = [new Set(), [], []];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...args, help: true };
    const next = argv[i + 1];
    if (BARE.has(flag) || (flag === '--power' && !(isString(next) && !next.startsWith('--')))) {
      modes.push(flag);
      used.push(flag);
      continue;
    }
    const value = argv[++i];
    if (!isString(value) || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (ROUND_FOUR_FLAGS.has(flag)) used.push(flag);
    if (flag === '--check-levels') {
      modes.push(flag);
      args.checkLevels = value;
    } else if (REPEATED.has(flag)) args[REPEATED.get(flag)].push(value);
    else if (!FLAGS.has(flag)) throw new Error(`unknown flag ${flag}\n${USAGE}`);
    else if (given.has(flag)) throw new Error(`${flag} given twice`);
    else {
      const [key, parse] = FLAGS.get(flag);
      args[key] = parse(value);
      given.add(flag);
    }
  }
  checkRoundFour(args, { given, used, modes });
  if (args.mode !== 'check-levels' && args.prices === null) throw new Error(USAGE);
  return args;
}

/** Per set, the plan's teach and apply tasks per family and its no-lesson share, from one arm and seed per sequence.
 * @param {{sequence: string, position: number, set: string, kind: string, familyId: string | null}[]} planCells */
export function planLayout(planCells) {
  const cells = [...new Map(planCells.map((c) => [`${c.sequence}@${c.position}`, c])).values()];
  const ofSet = (set) => {
    const lessonCells = cells.filter((c) => c.set === set && c.kind !== 'no-lesson');
    const byFamily = new Map();
    for (const c of lessonCells) {
      const f = byFamily.get(`${c.sequence}/${c.familyId}`) ?? { teach: 0, apply: 0 };
      f[c.kind]++;
      byFamily.set(`${c.sequence}/${c.familyId}`, f);
    }
    const families = [...byFamily.values()];
    if (families.length === 0) return null;
    return {
      families: families.length,
      teachPerFamily: mean(families.map((f) => f.teach)),
      applyPerFamily: mean(families.map((f) => f.apply)),
      familySizes: families.map((f) => f.teach + f.apply).sort((a, b) => a - b),
      noLessonRatio: set === 'R' ? cells.filter((c) => c.set === 'N').length / lessonCells.length : 0,
    };
  };
  return { R: ofSet('R'), X: ofSet('X') };
}

/** Mean sessions and list-price dollars per record by arm and kind, pooled per arm prefix as a fallback.
 * A session is the first one plus each teach or correction resume; a tool with no prices costs NaN. */
export function perRecordUsage(records, prices, opts = {}) {
  const cells = new Map();
  const add = (key, r, sessions, usd) => {
    const cell = cells.get(key) ?? { records: 0, sessions: 0, usd: Object.fromEntries(TOOLS.map((t) => [t, 0])) };
    cell.records++;
    cell.sessions += sessions;
    cell.usd[r.tool] = (cell.usd[r.tool] ?? 0) + usd;
    cells.set(key, cell);
  };
  for (const r of records) {
    if (r.usage === null) continue;
    const sessions = 1 + (r.teachTurns ?? 0) + (r.correctionTurns ?? 0);
    const usd = costOf(r, prices, opts);
    add(`${r.arm}/${r.kind}`, r, sessions, usd);
    add(`${ARM_TABLE[r.arm].group}*/${r.kind}`, r, sessions, usd);
  }
  return Object.fromEntries([...cells].map(([k, c]) => [k, {
    records: c.records, sessions: c.sessions / c.records, usd: Object.fromEntries(Object.entries(c.usd).map(([t, v]) => [t, v / c.records])),
  }]));
}

/** Sessions and dollars per tool for one design: every planned arm runs every task on its scored seeds (124).
 * @param {(arm: string) => number} seedsOf seeds the arm runs; the seed rule makes this a mean, so it need not be whole */
export function designUsage(design, layout, arms, table, seedsOf) {
  const tally = { sessions: 0, usd: Object.fromEntries(TOOLS.map((t) => [t, 0])), fallbacks: [] };
  const add = (arm, kind, perRepo) => {
    if (perRepo === 0) return;
    const rate = table[`${arm}/${kind}`] ?? table[`${ARM_TABLE[arm].group}*/${kind}`];
    if (!table[`${arm}/${kind}`]) tally.fallbacks.push(`${arm}/${kind}`);
    const n = perRepo * design.repos * seedsOf(arm);
    tally.sessions += n * (rate?.sessions ?? Number.NaN);
    for (const t of TOOLS) tally.usd[t] += n * (rate?.usd[t] ?? Number.NaN);
  };
  for (const arm of arms.rn) {
    add(arm, 'teach', design.setR * layout.R.teachPerFamily);
    add(arm, 'apply', design.setR * layout.R.applyPerFamily);
    add(arm, 'no-lesson', design.setN);
  }
  for (const arm of arms.x) {
    add(arm, 'teach', design.setX * layout.X.teachPerFamily);
    add(arm, 'apply', design.setX * layout.X.applyPerFamily);
  }
  return tally;
}

const passesPower = (power) => (x) => x.win >= power && x.tie >= power;

function sized(search, repos, unit) {
  if (search === undefined) return null;
  const size = { [`${unit}PerRepo`]: search.n, [unit]: search.n === null ? null : search.n * repos, power: search.result };
  return 'boundsPower' in search ? { ...size, boundsPower: search.boundsPower } : size;
}

// A seed-rule group runs the seeds of its own search, in the design's group order; any other arm runs wave 1's seeds.
const seedsFor = (groups, perGroup) => (arm) => {
  if (TWO_SEED_ARMS.has(arm)) return 2;
  const i = groups.findIndex((g) => g.arms.includes(arm));
  return i < 0 ? SEEDS : perGroup[i] ?? SEEDS;
};

/** One grid row: each hypothesis's smallest size at this many repositories, the sets they imply, and their usage. */
function gridRow(ctx, repos, m) {
  const { searches, layout, arms, table, quota } = ctx;
  const [h1, h2, h4] = [searches.H1?.(repos, m), searches.H2?.(repos, m), searches.H4?.(repos)];
  const row = { repos, H1: sized(h1, repos, 'families'), H2: sized(h2, repos, 'families'), H4: sized(h4, repos, 'tasks') };
  const fits = ctx.available && [h1, h2, h4].every((x) => x === undefined || x.n !== null);
  if (!fits) return { ...row, fits: false };
  const setR = h1.n;
  const lessonPerRepo = setR * (layout.R.teachPerFamily + layout.R.applyPerFamily);
  const design = { repos, setR, setN: Math.max(h4.n, Math.round(lessonPerRepo * layout.R.noLessonRatio)), setX: h2 ? h2.n : 0 };
  const use = designUsage(design, layout, arms, table, seedsFor(ctx.seedRule, [Math.max(h1.result.meanSeeds, SEEDS), h2 ? h2.result.meanSeeds : SEEDS]));
  const atCap = designUsage(design, layout, arms, table, seedsFor(ctx.seedRule, [ctx.seedCap, h2 ? ctx.seedCap : SEEDS]));
  const daysOf = (u) => Object.fromEntries(TOOLS.map((t) => [t, u.usd[t] / quota[t].usdPerDay]));
  const holdsAtBounds = (h) => h === undefined || (h.boundsPower !== null && passesPower(ctx.power)(h.boundsPower));
  return {
    ...row, fits, boundsPass: holdsAtBounds(h1) && holdsAtBounds(h2),
    setR: { familiesPerRepo: setR, families: setR * repos }, setN: { tasksPerRepo: design.setN, tasks: design.setN * repos },
    setX: { familiesPerRepo: design.setX, families: design.setX * repos },
    sessions: use.sessions, usd: use.usd, days: daysOf(use),
    usageAtCap: { sessions: atCap.sessions, usd: atCap.usd }, daysAtCap: daysOf(atCap), fallbacks: use.fallbacks,
  };
}

/** Rows that fit, those that pass at the bounds first, then the smallest set R families, set X families, and fewer repositories
 * (prereg 209: K is the smallest that passes). Seeds cannot shrink the family term, so a row that passes only at the estimates is the fallback. */
function choose(rows) {
  const fit = rows.filter((r) => r.fits);
  fit.sort((a, b) => Number(b.boundsPass) - Number(a.boundsPass) || a.setR.families - b.setR.families || a.setX.families - b.setX.families || a.repos - b.repos);
  return fit[0] ?? null;
}

const powerAt = ({ win, tie, meanSeeds, stopShare }) => ({ win, tie, meanSeeds, stopShare });

function searchesOf(cal, layout, opts) {
  const full = { sims: opts.sims, seed: opts.seed, cap: opts.seedCap, targetZ: opts.targetZ, onMiss: opts.onMiss };
  const coarse = { ...full, sims: Math.min(opts.searchSims, opts.sims) };
  const stages = coarse.sims < full.sims ? [coarse, full] : [full];
  const sizers = stages.map((stat) => ({
    H1: cal.H1.sim ? repeatSizer(cal.H1.sim, stat, 'H1') : null,
    H2: cal.H2.sim && layout.X ? repeatSizer(cal.H2.sim, stat, 'H2') : null,
    H4: cal.H4.sim ? harmSizer(cal.H4.sim, { ...stat, seeds: SEEDS }) : null,
  }));
  const atBounds = {
    H1: cal.H1.simUpper ? repeatSizer(cal.H1.simUpper, full, 'H1 bounds') : null,
    H2: cal.H2.simUpper && layout.X ? repeatSizer(cal.H2.simUpper, full, 'H2 bounds') : null,
  };
  // Every bisection step at the full sim count re-simulates the design, so a cheap one finds the size and the full count confirms it.
  const search = (h, evaluate, passes, cap) => {
    const found = smallestPassing((n) => evaluate(sizers[0][h], n), passes, cap);
    return stages.length === 1 ? found : confirmSize((n) => evaluate(sizers[1][h], n), passes, cap, found.n);
  };
  const familyCap = (repos) => Math.min(opts.maxFamiliesPerRepo, Math.floor(opts.maxFamilies / repos));
  const pass = passesPower(opts.power);
  const repeat = (h) => {
    if (!sizers[0][h]) return undefined;
    return (repos, m) => {
      const found = search(h, (power, families) => power({ repos, families }, m), pass, familyCap(repos));
      return { ...found, boundsPower: found.n === null ? null : powerAt(atBounds[h]({ repos, families: found.n }, m)) };
    };
  };
  const once = (fn) => {
    const memo = new Map();
    return (repos) => (memo.has(repos) ? memo.get(repos) : memo.set(repos, fn(repos)).get(repos));
  };
  return {
    H1: repeat('H1'), H2: repeat('H2'),
    H4: sizers[0].H4 ? once((repos) => search('H4', (power, tasks) => power({ repos, tasks }), (x) => x.pass >= opts.power, Math.floor(opts.maxNTasks / repos))) : undefined,
  };
}

/** The level of H1's test, and H2's when sized, at the chosen design: `held: false` stops the freeze. */
function levelOf(cal, chosen, m, opts) {
  const check = (h, families) => levelCheck(cal[h].sim, cal[h].simUpper, { repos: chosen.repos, families }, m,
    { sims: opts.levelSims, seed: opts.seed, cap: opts.seedCap, targetZ: opts.targetZ, onMiss: opts.onMiss, label: h });
  const [H1, H2] = [check('H1', chosen.setR.familiesPerRepo), chosen.H2 ? check('H2', chosen.setX.familiesPerRepo) : null];
  return { H1, H2, held: H1.held && (H2 === null || H2.held) };
}

/** Calibration estimates, then per minimum effect the grid rows and the chosen one. Abandoned runs are left out and listed.
 * @param {any[]} records @param {any[]} planCells @param {any} prices @param {any} opts */
export function sizeZ0(records, planCells, prices, opts) {
  const design = opts.design ?? DESIGNS.r3;
  if (isRoundFour(design)) return sizeReport(prepareR4(records, planCells, prices, opts), opts);
  const { filtered, abandoned, records: counted, planCells: cells } = filteredInput(records, planCells, opts, { dropAbandoned: true });
  const cal = calibrate(filtered, prices, opts.spreadBound, opts);
  const layout = planLayout(cells);
  const byTool = (tool) => filtered.arms.filter((a) => ARM_TABLE[a].tool === tool);
  const arms = { rn: byTool('claude-code'), x: layout.X ? byTool('codex') : [] };
  const table = perRecordUsage(withoutRuns(counted, abandoned), prices, opts);
  const unavailable = Object.entries(cal).filter(([h, c]) => c.reason !== undefined && !(h === 'H2' && layout.X === null)).map(([h, c]) => `${h}: ${c.reason}`);
  const ctx = {
    searches: searchesOf(cal, layout, opts), layout, arms, table, quota: opts.quota, power: opts.power, seedCap: opts.seedCap,
    seedRule: design.seedRule, available: unavailable.length === 0 && layout.R !== null,
  };
  const effects = opts.effects.map((m) => {
    const rows = opts.repos.map((repos) => gridRow(ctx, repos, m));
    const chosen = choose(rows);
    return { minimumEffect: m, rows, chosen, level: chosen === null ? null : levelOf(cal, chosen, m, opts) };
  });
  const strip = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'sim' && k !== 'simUpper'));
  return {
    calibration: {
      records: counted.length, scored: filtered.scored.length, abandoned: [...abandoned.values()].sort(),
      ...Object.fromEntries(Object.entries(cal).map(([h, c]) => [h, strip(c)])), plan: layout, perRecord: table,
    },
    unavailable, effects,
  };
}

const NOTES = [
  'Power runs through the analyzer\'s own fixed-repository t tests (family is the unit) at Holm\'s strictest level, 0.05/2 over H1 and H2 (prereg 209, Amendment 2); a win needs both codings.',
  'H3 is reported with no verdict, so it sets no size; set R is sized by H1 alone.',
  'Seeds follow the blind rule: wave 1 runs 3 seeds, then the fewest up to seedCap whose predicted standard error is at most the minimum effect over targetZ, the larger of the two codings. A run the rule cannot size runs at seedCap (onMiss cap, the default); with onMiss stop it stops and counts as neither win nor tie.',
  'A size passes at the calibration\'s point estimates. boundsPower repeats that size with every spread at its one-sided spreadBound upper bound, and choose prefers the rows that pass there.',
  'Set N\'s one-sided resolve share is taken at its exact one-sided spreadBound upper bound (Clopper-Pearson); resolve.oneSideEstimate is the point value.',
  'Families per repository are capped at maxFamiliesPerRepo. Each size is found by a search at searchSims, then confirmed at sims one size at a time; reported power is from the full sim count.',
  'Sessions count each record\'s first session plus its teach and correction resumes, at the rule\'s mean seeds; screen sessions are not counted. usageAtCap prices the rule\'s arms at seedCap.',
  'Days are list-price dollars of usage over the per-day quota; a quota marked "default assumption" is a placeholder, not a measurement.',
  'level is the share of true-zero runs below Holm\'s strictest 0.025, at the chosen design under the seed rule at the bounds, the seed rule at the point estimates, 3 seeds, 2 seeds at the bounds and 0/1 values. Each cell is read against 0.025 plus 2 simulation errors of the runs it kept (a rule cell drops the runs it stopped), and a cell with no run fails; held: false stops the freeze.',
];

/** The report of the default round 4 sizer: round 3's calibration counts and usage table, then each test's count, errors and power, `T2aMiss` and the bounds.
 * @param {any} p `prepareR4`'s reading @param {any} opts @returns {any} */
function sizeReport(p, opts) {
  return { calibration: { records: p.records, scored: p.scored.length, abandoned: p.abandoned, perRecord: perRecordUsage(p.usable, p.prices, opts) }, ...sizeR4(p, opts) };
}

/** `--read-set`: each pair's runs, plan and off-pin file join the argv's own, and its merge manifests are kept for the gates; its `--max-seed` line is not read.
 * @param {any} args @param {string} cwd */
export function expandReadSet(args, cwd) {
  for (const pair of readReadSet(path.resolve(cwd, args.readSet)).pairs) {
    if (pair.runs !== null) {
      args.runs.push(pair.runs);
      args.plan.push(pair.plan);
      args.offPin.push(pair.offPin);
    }
    if (pair.mergeManifest !== null) args.mergeManifest.push(pair.mergeManifest);
  }
  if (args.runs.length === 0 || args.plan.length === 0) throw new Error(`--read-set ${args.readSet}: it names no runs file and plan`);
}

/** The roles `inputHashes` lists after runs, plan, prices, grading, drop list and off-pin, each only when its flag is set. */
export const extraRows = (args) => [
  ...(args.wholePlan ?? []).map((f) => ['whole-plan', f]), ...args.levels.map((f) => ['levels', f]),
  ...[['pre-levels', args.preLevels], ['spend-basis', args.spendBasis], ['r3-unblind', args.r3Unblind], ['read-set', args.readSet]].filter(([, f]) => isString(f)),
  ...args.mergeManifest.map((f) => ['merge-manifest', f]),
];

/** The item 12 projection at these seed counts, as a line: the binding check is `z0-budget admit`'s. */
function spendLine(args, cwd, countsByArm) {
  const usd = projectSpend({ basisByArm: readBasis(path.resolve(cwd, args.spendBasis)).basisByArm, r: args.costRatio, seedsByArm: countsByArm });
  return `projected spend at r ${args.costRatio} and the rule counts: $${usd.toFixed(2)}, before q145's gap and the pilot; z0-budget admit makes the binding check`;
}

function powerMode(args, p, opts, cwd, real) {
  const read = powerFigures(p, { sims: opts.sims, levels: opts.levels, costRatio: args.costRatio, wholeRun: !real, second: real });
  const beside = args.r3Unblind === null ? null : r3Attribution(args.r3Unblind, cwd);
  const spend = real && args.spendBasis !== null ? spendLine(args, cwd, previewR4(p, opts).countsByArm) : null;
  const { lines, code } = powerLines(read, { wholeRun: !real, beside, spend });
  return { lines, code, json: { power: read } };
}

function previewMode(args, p, opts, cwd) {
  const { countsByArm, count } = previewR4(p, opts);
  const spend = args.spendBasis !== null && args.costRatio !== null ? [spendLine(args, cwd, countsByArm)] : [];
  const seeds = `seeds ${Object.entries(countsByArm).map(([arm, n]) => `${arm} ${n}`).join(', ')}`;
  return { lines: [seeds, ...spend], code: 0, file: { schema: SEED_PREVIEW_SCHEMA, countsByArm, count } };
}

function levelMode(args, p, opts, cwd, real, hashes) {
  const pre = args.preLevels === null ? {} : { pre: readLevelFiles([args.preLevels], cwd)[0] };
  const inputs = hashes().filter((r) => r.role !== 'source');
  const { file, lines, code } = levelCheckR4(p, { levelSims: opts.levelSims, source: real ? 'batch-1' : 'pre-freeze', commit: headCommit(), inputs, ...pre });
  return { lines, code, file };
}

/** The round 4 modes of one read: they print text, headed by the layout's repository count, and `--out` takes the mode's JSON file.
 * @param {any} args @param {any} inputs `loadInputs`' result @param {string} cwd @param {any} settings @returns {{code: number, stdout: string, stderr: string}} */
function runRoundFour(args, inputs, cwd, settings) {
  const real = isRound4Design(inputs.design);
  if (real && args.mode !== null && args.wholePlan.length === 0) throw new Error(`batch 1 holds ${repoCount(inputs.planCells)} repositories; pass --whole-plan so the counts are the whole run's`);
  const wholePlans = readWholePlans(args.wholePlan, cwd);
  if (args.mode === 'batch1-block') {
    const mergeManifests = args.mergeManifest.map((f) => readMergeManifest(path.resolve(cwd, f)));
    return { ...runBlock({ key: args.key, out: args.out, mergeManifests }, inputs, cwd, wholePlans), stderr: '' };
  }
  const notes = [];
  const levels = levelsFor(inputs.design, readLevelFiles(args.levels, cwd), (m) => notes.push(m));
  const opts = { ...settings, ...filterOpts(inputs), seed: R4_SEED, wholePlans, levels, costRatio: args.costRatio };
  const p = prepareR4(inputs.records, inputs.planCells, inputs.prices, opts);
  const hashes = () => inputHashes(args, cwd, { entry: ENTRY, extra: extraRows(args) });
  const modes = {
    size: () => {
      const sized = sizeReport(p, opts);
      return { lines: sizeLines(sized), code: 0, json: sized };
    },
    power: () => powerMode(args, p, opts, cwd, real), 'seed-rule-preview': () => previewMode(args, p, opts, cwd), 'level-check': () => levelMode(args, p, opts, cwd, real, hashes),
  };
  const mode = modes[args.mode ?? 'size']();
  const shown = { ...settings, seed: R4_SEED, levels: args.levels, partAEffect: args.costRatio === null ? null : Math.log(0.5 * args.costRatio) };
  const file = mode.file ?? (mode.json === undefined ? undefined : {
    schema: 'z0-size/2', mode: args.mode ?? 'size', settings: shown, inputs: hashes(), warnings: inputs.warnings, repositories: p.repos, ...mode.json,
  });
  if (args.out !== null && file !== undefined) {
    try {
      writeFileAtomic(path.resolve(cwd, args.out), `${JSON.stringify(file, null, 2)}\n`);
    } catch (e) {
      throw new Error(`--out ${args.out}: ${e.message}`);
    }
  }
  return { code: mode.code, stdout: `${[`${p.repos} repositories`, ...notes, ...mode.lines].join('\n')}\n`, stderr: '' };
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  const fail = (message) => ({ code: 1, stdout: '', stderr: `${message}\n` });
  let report;
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    if (args.mode === 'check-levels') {
      const { code, lines } = checkLevels(args.checkLevels, cwd);
      return { code, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    if (args.readSet !== null) expandReadSet(args, cwd);
    const inputs = loadInputs(args, cwd);
    const quota = {
      'claude-code': { usdPerDay: args.claudeQuota ?? QUOTA_USD_PER_DAY['claude-code'], source: args.claudeQuota === null ? 'default assumption' : 'flag' },
      codex: { usdPerDay: args.codexQuota ?? QUOTA_USD_PER_DAY.codex, source: args.codexQuota === null ? 'default assumption' : 'flag' },
    };
    const settings = {
      ...Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, args[k]])), firstWave: SEEDS, holmLevel: 0.05 / 2, quota,
      design: args.design, wholePlan: args.wholePlan.length === 0 ? null : args.wholePlan, preLevels: args.preLevels, costRatio: args.costRatio, spendBasis: args.spendBasis,
    };
    if (isRoundFour(inputs.design)) return runRoundFour(args, inputs, cwd, settings);
    const sizing = sizeZ0(inputs.records, inputs.planCells, inputs.prices, { ...settings, ...filterOpts(inputs) });
    const hashes = inputHashes(args, cwd, { entry: ENTRY });
    report = { schema: 'z0-size/1', settings, inputs: hashes, warnings: inputs.warnings, ...sizing, notes: NOTES };
  } catch (e) {
    return fail(e.message);
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out === null) return { code: 0, stdout: json, stderr: '' };
  try {
    fs.writeFileSync(path.resolve(cwd, args.out), json);
  } catch (e) {
    return fail(`--out ${args.out}: ${e.message}`);
  }
  return { code: 0, stdout: summary(report), stderr: '' };
}

const fmt = (x, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a');

function summary(report) {
  const lines = report.effects.map(({ minimumEffect, chosen: c, level }) => {
    const head = `minimum effect ${Math.round(minimumEffect * 100)} points`;
    if (c === null) return `${head}: no grid row fits`;
    return `${head}: ${c.repos} repositories, set R ${c.setR.families} families, set N ${c.setN.tasks} tasks, set X ${c.setX.families} families, `
      + `${Math.round(c.sessions)} sessions, ${TOOLS.map((t) => `${t} ${fmt(c.days[t])} days`).join(', ')}, `
      + `H1 mean seeds ${fmt(c.H1.power.meanSeeds)}, ${level.held ? 'level held' : 'level FAILED'}`;
  });
  return `${[...lines, ...report.unavailable.map((u) => `unavailable ${u}`)].join('\n')}\n`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
