#!/usr/bin/env node
/** Z0 sizing, part 2 of 2 (stage 2 step S5, D6): reads calibration records, estimates the spreads and not-applicable rates,
 * searches a repositories-by-families grid for the sizes prereg 209-215 asks for, and prices sessions and days of plan usage.
 * Writes JSON to stdout, or to --out with a one-line summary per effect on stdout. Exit 0 on a report, 1 on bad input. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addUsage, priceUsage } from '../../dist/eval/eval-stats.js';
import { loadInputs } from './z0-analyze.mjs';
import { inputHashes, sha256 } from './z0-blind.mjs';
import { abandonedRuns, filterRecords } from './z0-filters.mjs';
import { CODINGS, byCoding, codexApply, inSets, mean, repeatMistakeUnits, sum, taskUnits, withoutRuns } from './z0-hypotheses.mjs';
import { TWO_SEED_ARMS, isString, validateCorpus } from './z0-records.mjs';
import { SEEDS, clopperPearsonUpper, confirmSize, harmSizer, levelCheck, repeatSizer, smallestPassing, spreadComponents } from './z0-size-sim.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = ['scripts/token-eval/z0-size.mjs', 'scripts/token-eval/z0-size-sim.mjs'];
const TOOLS = ['claude-code', 'codex'];
// SHORTCUT: placeholder quotas in list-price dollars a day, not measured; S9 passes the screen's measured usage per plan window (D7).
export const QUOTA_USD_PER_DAY = { 'claude-code': 300, codex: 100 };
export const DEFAULTS = {
  repos: [5, 8, 10, 12, 15, 20], effects: [0.15, 0.2, 0.25], power: 0.8, sims: 2_000, seed: 1,
  searchSims: 200, maxFamilies: 60, maxFamiliesPerRepo: 4, maxNTasks: 600, spreadBound: 0.8,
  seedCap: 9, targetZ: 3.5, levelSims: 20_000,
};
const USAGE = 'usage: z0-size.mjs --runs FILE [--runs FILE ...] --plan FILE [--plan FILE ...] --prices FILE [--drop-list FILE] '
  + '[--repos 5,8,10,12,15,20] [--effects 0.15,0.2,0.25] [--power 0.8] [--sims 2000] [--seed 1] '
  + '[--search-sims 200] [--max-families 60] [--max-families-per-repo 4] [--max-n-tasks 600] [--spread-bound 0.8] '
  + '[--seed-cap 9] [--target-z 3.5] [--level-sims 20000] '
  + '[--claude-usd-per-day 300] [--codex-usd-per-day 100] [--out FILE]';

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
const list = (parse) => (v) => v.split(',').map(parse);
const FLAGS = new Map([
  ['--prices', ['prices', String]], ['--drop-list', ['dropList', String]], ['--out', ['out', String]],
  ['--repos', ['repos', list(integer('--repos', 2))]], ['--effects', ['effects', list(fraction('--effects'))]],
  ['--power', ['power', fraction('--power')]], ['--sims', ['sims', integer('--sims', 1)]],
  ['--seed', ['seed', integer('--seed', 1)]], ['--search-sims', ['searchSims', integer('--search-sims', 1)]],
  ['--max-families', ['maxFamilies', integer('--max-families', 1)]],
  ['--max-families-per-repo', ['maxFamiliesPerRepo', integer('--max-families-per-repo', 2)]],
  ['--max-n-tasks', ['maxNTasks', integer('--max-n-tasks', 1)]], ['--spread-bound', ['spreadBound', fraction('--spread-bound')]],
  ['--seed-cap', ['seedCap', integer('--seed-cap', 3)]], ['--target-z', ['targetZ', positive('--target-z')]],
  ['--level-sims', ['levelSims', integer('--level-sims', 1)]],
  ['--claude-usd-per-day', ['claudeQuota', positive('--claude-usd-per-day')]], ['--codex-usd-per-day', ['codexQuota', positive('--codex-usd-per-day')]],
]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { runs: [], plan: [], prices: null, dropList: null, grading: null, out: null, claudeQuota: null, codexQuota: null, help: false, ...DEFAULTS };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...args, help: true };
    const value = argv[++i];
    if (!isString(value) || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (flag === '--runs' || flag === '--plan') args[flag.slice(2)].push(value);
    else if (!FLAGS.has(flag)) throw new Error(`unknown flag ${flag}\n${USAGE}`);
    else if (given.has(flag)) throw new Error(`${flag} given twice`);
    else {
      const [key, parse] = FLAGS.get(flag);
      args[key] = parse(value);
      given.add(flag);
    }
  }
  if (args.runs.length === 0 || args.plan.length === 0 || args.prices === null) throw new Error(USAGE);
  return args;
}

/** Share of the arm pair's apply lessons marked not applicable on the first attempt. */
function naRate(s, armT, armC, keep) {
  const lessons = s.filter((r) => (r.arm === armT || r.arm === armC) && r.kind === 'apply' && keep(r)).flatMap((r) => r.lessons);
  return lessons.length === 0 ? 0 : lessons.filter((l) => l.first === 'na').length / lessons.length;
}

/** H1 or H2 spreads per coding. The effect is defined on applicable checks, and `violation` counts na as a fail
 * in both arms, so it carries (1 - na rate) of the effect; `loss` is the share of units a coding drops. */
function repeatCalibration(s, armT, armC, keep, bound) {
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
function ratioCalibration(units, bound) {
  const priced = units.filter((u) => u.t.cost > 0 && u.c.cost > 0);
  const components = spreadComponents(priced.map((u) => ({ repo: u.repo, family: u.family, seed: u.seed, value: Math.log(u.t.cost / u.c.cost) })), bound);
  if (components === null) return { reason: 'needs priced A1 and A2 pairs in a repository with 2 tasks and 2 seeds' };
  const controlSd = sdOf(priced.map((u) => Math.log(u.c.cost)));
  return { components, controlSd, sim: { family: components.family, sequence: components.sequence, noise: components.noise, controlSd } };
}

/** Set N's spreads plus its resolve pairs. A true zero makes the two discordant cells equal, so each gets half the discordant
 * share, taken at its exact one-sided upper bound at `bound` (few pairs barely estimate it). */
function harmCalibration(units, bound) {
  const cost = ratioCalibration(units, bound);
  if (cost.sim === undefined) return { reason: 'needs set N pairs in a repository with 2 tasks and 2 seeds' };
  const n = units.length;
  const both = units.filter((u) => u.t.resolved && u.c.resolved).length / n;
  const discordant = units.filter((u) => u.t.resolved !== u.c.resolved).length;
  const oneSide = clopperPearsonUpper(discordant, n, bound) / 2;
  return { ...cost, resolve: { pairs: n, discordant, both, oneSide, oneSideEstimate: discordant / n / 2 }, sim: { ...cost.sim, both, oneSide } };
}

/** The spreads each sized hypothesis needs, from the records the analyzer would score. H3 carries no verdict, so it sets no size. */
export function calibrate(filtered, prices, bound) {
  const s = filtered.scored;
  const planned = (...arms) => arms.every((a) => filtered.arms.includes(a));
  const notPlanned = (arms) => ({ reason: `${arms} not in the calibration plan` });
  return {
    H1: planned('A1', 'A2') ? repeatCalibration(s, 'A2', 'A1', inSets('R'), bound) : notPlanned('A1, A2'),
    H2: planned('X2', 'X3') ? repeatCalibration(s, 'X2', 'X3', codexApply, bound) : notPlanned('X2, X3'),
    H4: planned('A1', 'A2') ? harmCalibration(taskUnits(s, 'A2', 'A1', prices['claude-code'], inSets('N')), bound) : notPlanned('A1, A2'),
  };
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
export function perRecordUsage(records, prices) {
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
    const usd = prices[r.tool] ? priceUsage(addUsage(r.usage.firstSession, r.usage.extra), prices[r.tool]) : Number.NaN;
    add(`${r.arm}/${r.kind}`, r, sessions, usd);
    add(`${r.arm[0]}*/${r.kind}`, r, sessions, usd);
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
    const rate = table[`${arm}/${kind}`] ?? table[`${arm[0]}*/${kind}`];
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

const RULE_ARMS = { H1: ['A1', 'A2', 'A5'], H2: ['X2', 'X3'] };
const seedsFor = (h1, h2) => (arm) => {
  if (TWO_SEED_ARMS.has(arm)) return 2;
  return RULE_ARMS.H1.includes(arm) ? h1 : RULE_ARMS.H2.includes(arm) ? h2 : SEEDS;
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
  const use = designUsage(design, layout, arms, table, seedsFor(Math.max(h1.result.meanSeeds, SEEDS), h2 ? h2.result.meanSeeds : SEEDS));
  const atCap = designUsage(design, layout, arms, table, seedsFor(ctx.seedCap, h2 ? ctx.seedCap : SEEDS));
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
  const full = { sims: opts.sims, seed: opts.seed, cap: opts.seedCap, targetZ: opts.targetZ };
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
    { sims: opts.levelSims, seed: opts.seed, cap: opts.seedCap, targetZ: opts.targetZ, label: h });
  const [H1, H2] = [check('H1', chosen.setR.familiesPerRepo), chosen.H2 ? check('H2', chosen.setX.familiesPerRepo) : null];
  return { H1, H2, held: H1.held && (H2 === null || H2.held) };
}

/** Calibration estimates, then per minimum effect the grid rows and the chosen one. Abandoned runs are left out and listed.
 * @param {any[]} records @param {any[]} planCells @param {any} prices @param {any} opts */
export function sizeZ0(records, planCells, prices, opts) {
  validateCorpus(records, planCells);
  const abandoned = abandonedRuns(records, planCells);
  const kept = withoutRuns(planCells, abandoned);
  const filtered = filterRecords(withoutRuns(records, abandoned), kept, { dropList: opts.dropList ?? null });
  const cal = calibrate(filtered, prices, opts.spreadBound);
  const layout = planLayout(planCells);
  const arms = { rn: filtered.arms.filter((a) => a.startsWith('A')), x: layout.X ? filtered.arms.filter((a) => a.startsWith('X')) : [] };
  const table = perRecordUsage(withoutRuns(records, abandoned), prices);
  const unavailable = Object.entries(cal).filter(([h, c]) => c.reason !== undefined && !(h === 'H2' && layout.X === null)).map(([h, c]) => `${h}: ${c.reason}`);
  const ctx = {
    searches: searchesOf(cal, layout, opts), layout, arms, table, quota: opts.quota, power: opts.power, seedCap: opts.seedCap,
    available: unavailable.length === 0 && layout.R !== null,
  };
  const effects = opts.effects.map((m) => {
    const rows = opts.repos.map((repos) => gridRow(ctx, repos, m));
    const chosen = choose(rows);
    return { minimumEffect: m, rows, chosen, level: chosen === null ? null : levelOf(cal, chosen, m, opts) };
  });
  const strip = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'sim' && k !== 'simUpper'));
  return {
    calibration: {
      records: records.length, scored: filtered.scored.length, abandoned: [...abandoned.values()].sort(),
      ...Object.fromEntries(Object.entries(cal).map(([h, c]) => [h, strip(c)])), plan: layout, perRecord: table,
    },
    unavailable, effects,
  };
}

const NOTES = [
  'Power runs through the analyzer\'s own fixed-repository t tests (family is the unit) at Holm\'s strictest level, 0.05/2 over H1 and H2 (prereg 209, Amendment 2); a win needs both codings.',
  'H3 is reported with no verdict, so it sets no size; set R is sized by H1 alone.',
  'Seeds follow the blind rule: wave 1 runs 3 seeds, then the fewest up to seedCap whose predicted standard error is at most the minimum effect over targetZ, the larger of the two codings. A run the rule cannot size stops and counts as neither win nor tie.',
  'A size passes at the calibration\'s point estimates. boundsPower repeats that size with every spread at its one-sided spreadBound upper bound, and choose prefers the rows that pass there.',
  'Set N\'s one-sided resolve share is taken at its exact one-sided spreadBound upper bound (Clopper-Pearson); resolve.oneSideEstimate is the point value.',
  'Families per repository are capped at maxFamiliesPerRepo. Each size is found by a search at searchSims, then confirmed at sims one size at a time; reported power is from the full sim count.',
  'Sessions count each record\'s first session plus its teach and correction resumes, at the rule\'s mean seeds; screen sessions are not counted. usageAtCap prices the rule\'s arms at seedCap.',
  'Days are list-price dollars of usage over the per-day quota; a quota marked "default assumption" is a placeholder, not a measurement.',
  'level is the share of true-zero runs below Holm\'s strictest 0.025, at the chosen design under the seed rule at the bounds, 3 seeds, 2 seeds at the bounds and 0/1 values. It is read against 0.025 plus 2 simulation errors; held: false stops the freeze.',
];

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  const fail = (message) => ({ code: 1, stdout: '', stderr: `${message}\n` });
  let report;
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    const inputs = loadInputs(args, cwd);
    const quota = {
      'claude-code': { usdPerDay: args.claudeQuota ?? QUOTA_USD_PER_DAY['claude-code'], source: args.claudeQuota === null ? 'default assumption' : 'flag' },
      codex: { usdPerDay: args.codexQuota ?? QUOTA_USD_PER_DAY.codex, source: args.codexQuota === null ? 'default assumption' : 'flag' },
    };
    const settings = { ...Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, args[k]])), firstWave: SEEDS, holmLevel: 0.05 / 2, quota };
    const sizing = sizeZ0(inputs.records, inputs.planCells, inputs.prices, { ...settings, dropList: inputs.dropList });
    const hashes = [...inputHashes(args, cwd), ...SOURCES.map((f) => ({ role: 'source', file: f, sha256: sha256(path.join(REPO, f)) }))];
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
