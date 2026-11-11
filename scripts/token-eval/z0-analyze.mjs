#!/usr/bin/env node
/** Z0 analyzer, part 6 of 6: `analyzeZ0` composes contract, filters, gates and hypotheses; the CLI reads files and reports.
 * Usage and readings: docs/evals/2026-10-03-z0-analyzer.md. Exit 0 on a report (invalid runs too), 1 on bad input, 2 on a refused unblind. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESIGNS, designByName, designName, isRound4Design, pairOf } from './arms.mjs';
import { batchKeysOf, checkSeedRule, effortOf, expandReadSet, headlineR4, levelsOf, scoreR4, seedWindows } from './z0-analyze-r4.mjs';
import { SEALED, blindView, inputHashes, loadOrCreateKey, sha256, unblindRefusal } from './z0-blind.mjs';
import { filteredInput, readVoids } from './z0-filters.mjs';
import { computeGates } from './z0-gates.mjs';
import { BEHAVIOUR_SENTENCE, CODINGS, LESSONS_SENTENCE, NOT_RUN, computeHypotheses, computeReported, driftR4, estimatesR4, publishR4, readoutsR4 } from './z0-hypotheses.mjs';
import { spendByArm } from './z0-ledger.mjs';
import { readMergeManifest } from './z0-merge.mjs';
import { checkPrices } from './z0-prices.mjs';
import { isString, parsePlan, parseZ0Records } from './z0-records.mjs';
import { NO_VERDICT } from './z0-verdict-r4.mjs';

export { expandReadSet, headlineR4, scoreR4, seedWindows };

export const ITERATIONS = 10_000;
export const SEED = 1;
export const ABANDONED = 'abandoned';
export const NOT_ANALYSED = 'not analysed: the run is abandoned (prereg 114)';
const USAGE = 'usage: z0-analyze.mjs --runs FILE [--runs FILE ...] --plan FILE [--plan FILE ...] --prices FILE [--grading FILE] [--drop-list FILE] [--off-pin FILE ...] [--merge-manifest FILE ...] [--key FILE] [--unblind] [--seed N --iterations N] [--out FILE]'
  + ' [--design r3|r4]; round 4 only: [--read-set FILE] --levels FILE --levels FILE --seed-rule FILE --pins FILE --drift-runs FILE ... --drift-plan FILE ... [--ledger-runs DIR ...] (with --unblind)';
const SINGLE = new Map([['--prices', 'prices'], ['--grading', 'grading'], ['--drop-list', 'dropList'], ['--key', 'key'], ['--out', 'out'], ['--seed', 'seed'], ['--iterations', 'iterations'],
  ['--design', 'design'], ['--read-set', 'readSet'], ['--seed-rule', 'seedRule'], ['--pins', 'pins']]);
const REPEATED = new Map([['--runs', 'runs'], ['--plan', 'plan'], ['--off-pin', 'offPin'], ['--merge-manifest', 'mergeManifest'], ['--levels', 'levels'], ['--drift-runs', 'driftRuns'], ['--drift-plan', 'driftPlan'], ['--ledger-runs', 'ledgerRuns']]);
// The flags only a round 4 read takes, in the order a round 3 read is refused them.
const ROUND_4_ONLY = [['--read-set', 'readSet'], ['--levels', 'levels'], ['--seed-rule', 'seedRule'], ['--pins', 'pins'], ['--drift-runs', 'driftRuns'], ['--drift-plan', 'driftPlan'], ['--ledger-runs', 'ledgerRuns']];
const LEVELS_STOP = 'each test keeps the lower of its two levels (prereg Level check); pass the pre-freeze and the batch 1 levels files';

/** The design's arms and sets the plan left out (reading 11), both read from the plan; "not run" must not read as the registered design. */
export function unplannedDesign(filtered, design = DESIGNS.r3) {
  const arms = design.arms.filter((a) => !filtered.arms.includes(a));
  const sets = design.sets.filter((s) => !filtered.sets.includes(s)).map((s) => `set ${s}`);
  return [...arms, ...sets];
}

const noRefuse = () => {
  throw new Error('analyzeZ0: unblind needs a refuse callback that runs the commit and G5 checks (z0-blind.mjs unblindRefusal)');
};

const NEEDED_R4 = { levels: '--levels', seedRule: '--seed-rule', batchKeys: '--pins', drift: '--drift-runs and --drift-plan', spend: '--ledger-runs' };

/** Round 4's block in place of the hypothesis family: windows, estimates with their closed-test scores, read-outs, drift, headline and publish list.
 * `opts.spend` (spend by arm) is called here and nowhere else, so recorded spend is read only once the codes are open. */
function roundFour({ filtered, kept, planCells }, opts, stat) {
  const missing = Object.keys(NEEDED_R4).find((k) => opts[k] === undefined || opts[k] === null);
  if (missing !== undefined) throw new Error(`a round 4 read needs ${NEEDED_R4[missing]}`);
  const { design } = stat;
  const windows = seedWindows(planCells, design, opts.seedRule, opts.batchKeys);
  const run = { ...stat, windows, maxSeed: opts.maxSeed ?? null };
  const estimates = estimatesR4(filtered, opts.prices, run);
  const scored = scoreR4(estimates, opts.levels, windows);
  const readouts = readoutsR4(filtered, opts.prices, run, opts.spend());
  const { asOf } = opts.prices;
  const headline = headlineR4({ design, scored, estimates, asOf, pooled: readouts.pooled, spendPerSolve: readouts.spendPerSolve });
  return {
    effort: effortOf(design), asOf, notes: opts.notes ?? [], windows, levels: opts.levels, estimates, scored, readouts,
    drift: driftR4(kept, planCells, opts.drift, opts.prices, run), headline, publish: publishR4(filtered, opts.prices, run),
  };
}

const hypothesesOf = (read, opts, stat) => (isRound4Design(stat.design) ? roundFour(read, opts, stat) : computeHypotheses(read.filtered, opts.prices, stat));

/** Validation, filters and gates; the hypothesis and reported blocks only when unblinding is allowed and every gate passes.
 * An abandoned run is never analysed (114): no gates, no hypotheses, and its codes stay closed. */
export function analyzeZ0(records, opts) {
  const refuse = opts.refuse ?? noRefuse;
  const design = opts.design ?? DESIGNS.r3;
  const { filtered, unchecked, records: kept, planCells } = filteredInput(records, opts.planCells, opts, { dropAbandoned: false });
  const unplanned = unplannedDesign(filtered, design);
  if (filtered.abandoned.length > 0) {
    const refusal = opts.unblind ? 'the run is abandoned and never analysed (prereg 114), so its codes stay closed' : null;
    return { status: ABANDONED, unchecked, filtered, unplanned, gates: null, refusal, hypotheses: null, reported: null };
  }
  const stat = { iterations: opts.iterations ?? ITERATIONS, seed: opts.seed ?? SEED, design };
  const gates = computeGates(kept, filtered, opts.grading ?? null, { ...stat, offPinGiven: opts.offPinGiven === true, mergeManifests: opts.mergeManifests ?? [] });
  const refusal = opts.unblind ? refuse(gates) : null;
  const open = opts.unblind === true && refusal === null && gates.pass;
  return {
    status: gates.pass ? 'valid' : 'invalid', unchecked, filtered, unplanned, gates, refusal,
    hypotheses: open ? hypothesesOf({ filtered, kept, planCells }, opts, stat) : null,
    reported: open ? computeReported(kept, filtered, opts.prices, stat) : null,
  };
}

/** The rules a round 4 read adds: its inputs, two levels files, and ledger folders only when the codes open. */
function checkRoundFour(args) {
  if (args.prices === null) throw new Error(USAGE);
  if (args.readSet === null && (args.runs.length === 0 || args.plan.length === 0)) throw new Error('a round 4 read needs --runs and --plan, or --read-set');
  if (args.levels.length !== 2) throw new Error(LEVELS_STOP);
  for (const [flag, key] of ROUND_4_ONLY.filter(([, k]) => ['seedRule', 'pins', 'driftRuns', 'driftPlan'].includes(k))) {
    if (Array.isArray(args[key]) ? args[key].length === 0 : args[key] === null) throw new Error(`a round 4 read needs ${flag}`);
  }
  if (args.unblind && args.ledgerRuns.length === 0) throw new Error('a round 4 read needs --ledger-runs');
  if (!args.unblind && args.ledgerRuns.length > 0) throw new Error('--ledger-runs needs --unblind; spend by arm opens the arm codes');
}

export function parseArgs(argv) {
  const args = {
    runs: [], plan: [], offPin: [], mergeManifest: [], levels: [], driftRuns: [], driftPlan: [], ledgerRuns: [], prices: null, grading: null, dropList: null, key: null, out: null, seed: null, iterations: null,
    design: null, readSet: null, seedRule: null, pins: null, maxSeed: null, unblind: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...args, help: true };
    if (flag === '--unblind') {
      args.unblind = true;
      continue;
    }
    const value = argv[++i];
    if (!isString(value) || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (REPEATED.has(flag)) args[REPEATED.get(flag)].push(value);
    else if (!SINGLE.has(flag)) throw new Error(`unknown flag ${flag}\n${USAGE}`);
    else if (args[SINGLE.get(flag)] !== null) throw new Error(`${flag} given twice`);
    else args[SINGLE.get(flag)] = value;
  }
  for (const k of ['seed', 'iterations']) {
    if (args[k] === null) continue;
    args[k] = Number(args[k]);
    if (!Number.isInteger(args[k]) || args[k] < 1) throw new Error(`--${k} must be a positive integer`);
  }
  if (args.design !== null && !['r3', 'r4'].includes(args.design)) throw new Error(`--design takes r3 or r4, got ${args.design}`);
  if (args.design === 'r4') {
    checkRoundFour(args);
    return args;
  }
  const refused = ROUND_4_ONLY.find(([, key]) => (Array.isArray(args[key]) ? args[key].length > 0 : args[key] !== null));
  if (refused !== undefined) throw new Error(`${refused[0]} is round 4 only; pass --design r4`);
  if (args.runs.length === 0 || args.plan.length === 0 || args.prices === null) throw new Error(USAGE);
  return args;
}

function readJson(cwd, file) {
  const text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not JSON (${e.message})`);
  }
}

const isNames = (v) => Array.isArray(v) && v.every(isString);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isPosition = (v) => v !== null && isString(v.sequence) && isCount(v.seed) && isCount(v.position);
const isRate = (v) => v === null || Number.isFinite(v);
const isUnit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const isCi = (v) => v === null || (Array.isArray(v) && v.length === 2 && v.every(isUnit) && v[0] <= v[1]);
const isTable = (t, s) => ['yesYes', 'yesNo', 'noYes', 'noNo'].every((k) => isCount(t?.[k])) && t.yesYes + t.yesNo + t.noYes + t.noNo === s.n && t.yesYes + t.noNo === s.agree;
const isStoredSample = (s) => s !== null && isCount(s.n) && isCount(s.agree) && s.agree <= s.n && isRate(s.agreement) && isRate(s.kappa) && isCi(s.ci95) && isTable(s.table, s);

/** Round 4's own inputs, each read only when its flag is given: the levels (with minLevels' notes), the seed rule, the frozen layout's keys and the drift records. */
function readRoundFour(args, cwd) {
  const out = { warnings: [] };
  const [levels, driftRuns, driftPlan] = [args.levels ?? [], args.driftRuns ?? [], args.driftPlan ?? []];
  if (levels.length > 0) Object.assign(out, levelsOf(levels, levels.map((f) => readJson(cwd, f))));
  if (args.seedRule) out.seedRule = checkSeedRule(readJson(cwd, args.seedRule), args.seedRule);
  if (args.pins) out.batchKeys = batchKeysOf(readJson(cwd, args.pins), args.pins);
  if (driftRuns.length > 0 || driftPlan.length > 0) {
    const parsed = driftRuns.map((f) => parseZ0Records(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f));
    out.drift = { records: parsed.flatMap((p) => p.records), planCells: driftPlan.flatMap((f) => parsePlan(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f)) };
    out.warnings.push(...parsed.flatMap((p) => p.warnings));
  }
  return out;
}

/** Reads every input file and rejects a malformed one by name; records keep their file and line. */
export function loadInputs(args, cwd) {
  // Checked before the blind key is written, so a bad --out leaves nothing behind.
  const outDir = args.out === null ? null : path.dirname(path.resolve(cwd, args.out));
  if (outDir !== null && !fs.existsSync(outDir)) throw new Error(`--out ${args.out}: folder ${outDir} does not exist`);
  const design = isString(args.design) ? designByName(args.design) : DESIGNS.r3;
  const records = [];
  const warnings = [];
  for (const f of args.runs) {
    const parsed = parseZ0Records(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f);
    records.push(...parsed.records);
    warnings.push(...parsed.warnings);
  }
  const planCells = args.plan.flatMap((f) => parsePlan(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f));
  // A price-free caller, such as the leak list, passes no --prices and reads no price file.
  const prices = isString(args.prices) ? readJson(cwd, args.prices) : null;
  if (prices !== null) checkPrices(prices, args.prices, design);
  const round4 = isRound4Design(design);
  if (round4 && prices !== null && !(isString(prices.asOf) && prices.asOf !== '')) throw new Error(`${args.prices}: asOf must be a non-empty string, the date of the list prices (the round 4 headline prints it)`);
  const offPin = args.offPin ?? [];
  // An off-pin file binds to the runs files this read loads; with none given no runs file is hashed here.
  const runHashes = offPin.length === 0 ? [] : args.runs.map((f) => sha256(path.resolve(cwd, f)));
  const voids = offPin.flatMap((f) => readVoids(f, { cwd, runHashes }));
  const grading = args.grading === null ? null : readJson(cwd, args.grading);
  if (grading !== null && !(isNames(grading.flippedLessons) && isCount(grading.acceptanceFlips) && isCount(grading.readerSample?.n) && isCount(grading.readerSample?.disagreements))) {
    throw new Error(`${args.grading}: needs flippedLessons (strings), acceptanceFlips and readerSample { n, disagreements } (integers)`);
  }
  if (grading?.storedSample !== undefined && !isStoredSample(grading.storedSample)) {
    throw new Error(`${args.grading}: storedSample needs n and agree (integers, agree <= n), agreement and kappa (numbers or null), ci95 (two rates, low first, or null) and table (four counts that sum to n)`);
  }
  const dropList = args.dropList === null ? null : readJson(cwd, args.dropList);
  if (dropList !== null && !(isNames(dropList.droppedLessons) && isNames(dropList.droppedFamilies))) {
    throw new Error(`${args.dropList}: needs droppedLessons and droppedFamilies (strings)`);
  }
  if (dropList?.hookVoids !== undefined && !(Array.isArray(dropList.hookVoids) && dropList.hookVoids.every(isPosition))) {
    throw new Error(`${args.dropList}: hookVoids needs { sequence (string), seed and position (integers) } entries`);
  }
  const mergeManifests = (args.mergeManifest ?? []).map((f) => readMergeManifest(path.resolve(cwd, f)));
  const { warnings: more, ...own } = round4 ? readRoundFour(args, cwd) : { warnings: [] };
  return { records, warnings: [...warnings, ...more], planCells, prices, grading, dropList, voids, design, offPinGiven: offPin.length > 0, mergeManifests, maxSeed: args.maxSeed ?? null, ...own };
}

/** The report object; blind mode keys every per-arm figure by code and carries no outcome by arm. */
export function buildReport(analysis, inputs, args, codes, hashes) {
  const blind = codes !== null;
  const view = blindView(analysis, blind ? codes : Object.fromEntries(analysis.filtered.arms.map((a) => [a, a])));
  const ofRecord = (args.iterations ?? ITERATIONS) === ITERATIONS && (args.seed ?? SEED) === SEED;
  const voids = blind ? view.voids : Object.fromEntries(Object.entries(analysis.filtered.counts).map(([a, c]) => [a, c.voidReasons]));
  const abandoned = analysis.status === ABANDONED;
  let hypotheses = blind ? SEALED : analysis.hypotheses;
  if (abandoned) hypotheses = NOT_ANALYSED;
  else if (!blind && !analysis.gates.pass) hypotheses = `withheld: invalid run (${analysis.gates.failed.join(', ')})`;
  return {
    schema: 'z0-report/1', mode: blind ? 'blind' : 'unblinded', status: analysis.status, ofRecord, iterations: args.iterations ?? ITERATIONS, seed: args.seed ?? SEED,
    abandoned: analysis.filtered.abandoned, designNotRun: analysis.unplanned, unchecked: analysis.unchecked,
    untaughtApplyDrops: analysis.filtered.untaughtApplyDrops, hookVoided: analysis.filtered.hookVoided.positions, warnings: inputs.warnings,
    counts: view.perCode, voids, gates: view.gates, invalid: abandoned ? null : analysis.gates.failed,
    hypotheses, reported: abandoned ? NOT_ANALYSED : blind ? SEALED : analysis.reported, hashes,
    storedSample: inputs.grading?.storedSample ?? null,
  };
}

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const pct = (x) => `${(100 * x).toFixed(1)}%`;
// A t result names its df, and its bootstrap twin prints beside it for comparison only.
const est = (e) => {
  if (isString(e)) return e;
  const twin = e.bootstrap ? `, bootstrap [${f3(e.bootstrap.low)}, ${f3(e.bootstrap.high)}]` : '';
  return `${f3(e.estimate)} [${f3(e.low)}, ${f3(e.high)}]${e.df === undefined ? '' : ` t(${Number(e.df.toFixed(1))})`}${twin}`;
};
const pairText = (p) => (isString(p) ? p : `violation ${est(p.violation)} (${p.violation.units} units); excluded ${est(p.excluded)} (${p.excluded.units} units)`);

/** The G1 env conditions, printed only when one fails (names uppercase, with the records that held each). */
const envText = (g1) => {
  const outside = Object.entries(g1.envKeysOutside).map(([name, n]) => `${name} in ${n}`).join(', ');
  return `${outside ? `; env names outside the allowlist: ${outside}` : ''}${g1.anthropicApiKeyRecords ? `; ${g1.anthropicApiKeyRecords} records hold ANTHROPIC_API_KEY` : ''}`;
};

function gateLines(r) {
  const g = r.gates;
  const half = (h) => (h.status === NOT_RUN ? `not run${h.required ? ' but required' : ''}` : `${h.status}, ${pairText(h)}`);
  const worst = Object.values(g.G4.perArm).reduce((m, a) => Math.max(m, a.share), 0);
  const off = g.G1.offPinVoided;
  const offText = off === undefined ? '' : `; off-pin voided ${off.positions} positions (${pct(off.share)}), ${g.G1.offPinPass ? 'within' : 'over'} the 5% bar`;
  const first = g.G3.firstRun;
  const firstText = first === undefined ? '' : `; first run ${first.leakedSequenceSeeds} of ${first.plannedRuns} leaked`;
  return [
    `G1 ${g.G1.pass ? 'pass' : 'fail'}: ${g.G1.operatorCanaries} operator canaries${envText(g.G1)}; void share ${Object.entries(g.G1.perArm).map(([k, v]) => `${k} ${pct(v.share)}`).join(', ')}${offText}`,
    `G2 ${g.G2.pass ? 'pass' : 'fail'}: Claude Code half ${half(g.G2.claudeCode)}; Codex half ${half(g.G2.codex)}`,
    `G3 ${g.G3.pass ? 'pass' : 'fail'}: ${g.G3.leaked} of ${g.G3.plannedRuns} planned (sequence, seed)s leaked${firstText}`,
    `G4 ${g.G4.pass ? 'pass' : 'fail'}: worst invalid-or-missing share ${pct(worst)}, gap ${(100 * g.G4.gap).toFixed(1)} points`,
    `G5 ${g.G5.pass ? 'pass' : `fail (${g.G5.status})`}${g.G5.n === undefined ? '' : `: ${g.G5.disagreements} of ${g.G5.n} reader-sampled grades disagree; flipped lessons ${g.G5.flippedLessons}, acceptance flips ${g.G5.acceptanceFlips}`}`,
  ];
}

const secondaryLines = (h3) => [
  'secondary, not tested in the family:',
  isString(h3) ? `H3 ${h3}` : `H3 cost ratio ${est(h3)}; first session ${est(h3.firstSession)}; extra turns ${est(h3.extra)}; retry-voided positions ${pct(h3.retryVoidedShare)}`,
];

function hypothesisLines(h) {
  const family = Object.keys(h.verdicts);
  const lines = [`primary family: ${family.join(', ')} (Holm, 0.05 over ${family.length})`];
  // H3 prints right after the family, wherever a failed H4 or a loss moved the family in the order.
  const lastFamily = Math.max(...family.map((n) => h.order.indexOf(n)));
  h.order.forEach((name, i) => {
    if (name === 'H4') {
      const g = h.H4;
      if (isString(g)) lines.push(`H4 ${g}`);
      else lines.push(`H4 ${g.gate.pass ? 'pass' : 'FAIL'}: ${g.reason ?? `set N cost ratio ${est(g.costRatio)}; resolve difference ${est(g.resolveDiff)}`}`);
    } else if (name === 'attribution') {
      const a = h.attribution;
      lines.push(isString(a) ? `attribution ${a}` : `attribution: ${a.sentence ?? a.reason}; A2 vs A5 ${a.violation === undefined ? NOT_RUN : pairText(a)}`);
    } else {
      const v = h.verdicts[name];
      const small = v.final.verdict === 'win' && !v.final.reachesMinimum ? ' (small win)' : '';
      const ps = v.violation ? `, adjusted p ${f3(v.violation.adjustedP)} / ${f3(v.excluded.adjustedP)}` : '';
      lines.push(`${name} ${v.final.verdict}${small}${ps}: ${pairText(h[name])}`);
    }
    if (i === lastFamily) lines.push(...secondaryLines(h.H3));
  });
  return lines;
}

function reportedLines(rep, design) {
  const lines = ['reported, no verdicts:'];
  // A reported test prints in the test lines; any other name the report lacks stops, since a silent drop hides a pair the design reports.
  for (const k of design.reported.filter((name) => !Object.hasOwn(design.tests, name))) {
    if (!Object.hasOwn(rep, k)) throw new Error(`design ${designName(design)} reports ${k}, but the report holds no block for it`);
    lines.push(`  ${k}: ${isString(rep[k]) || Object.hasOwn(rep[k], 'violation') ? pairText(rep[k]) : est(rep[k])}`);
  }
  for (const [arm, a] of Object.entries(rep.perArm)) lines.push(`  ${arm}: ${a.tasks} tasks, resolve ${est(a.resolveRate)}, cost per resolved ${est(a.costPerResolved)}, stale-follow ${est(a.staleFollow)}`);
  lines.push(`  maintainer only: H1 ${pairText(rep.maintainerOnly.H1)}; H2 ${pairText(rep.maintainerOnly.H2)}; H3 ${est(rep.maintainerOnly.H3)}`);
  lines.push(`  all applies: H1 ${pairText(rep.allApplies.H1)}`);
  const rate = (e) => (isString(e) ? e : f3(e.estimate));
  for (const [bucket, p] of Object.entries(rep.bySinceTeach)) {
    const seeds = (r) => (r.seeds.length === 0 ? '' : ` (seeds ${r.seeds.join(',')})`);
    const rates = Object.entries(rep.ratesBySinceTeach[bucket]).map(([arm, r]) => `${arm} ${rate(r.violation)}/${rate(r.excluded)}${seeds(r)}`);
    lines.push(`  tasksSinceTeach ${bucket}: ${pairOf(design, 'H1').join(' - ')} ${pairText(p)}; rates (violation/excluded) ${rates.join(', ')}`);
  }
  const wo = rep.wordOverlap;
  lines.push(`  wordOverlap Spearman: ${isString(wo) ? wo : `violation ${est(wo.violation)}; excluded ${est(wo.excluded)}`}`);
  const s = rep.sensitivity;
  lines.push(`  without ${s.carryUnionRuns} carry-union runs: H1 ${pairText(s.H1)}; H3 ${est(s.H3)}; ${s.retryVoidedPositions} positions voided by unrestored retries`);
  lines.push('  rotation slots and the memory-failure chain: see --out');
  return lines;
}

const KNIFE = ' (knife edge: a bound crosses the null)';
const PART_NAMES = { a: 'R', b: 'resolve difference', c: 'repeat difference' };
const belowCount = (test, w) => `${test} at seeds 1 to ${w.k}, below its count ${w.n}: no verdict`;
const usd = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : 'n/a');
const viewText = (v, at) => `${f3(v.estimate)} [${f3(v.bounds[at].low)}, ${f3(v.bounds[at].high)}] t(${Number(v.df.toFixed(1))})`;
const codedText = (v, at) => (v.codings === undefined ? viewText(v, at) : CODINGS.map((c) => `${c} ${viewText(v.codings[c], at)}`).join(', '));
const pText = (v) => (v.codings === undefined ? f3(v.p) : CODINGS.map((c) => f3(v.codings[c].p)).join('/'));
const eachView = (v) => (v.codings === undefined ? [v] : Object.values(v.codings));

/** One T2 or S1 part: its estimate and interval at threshold `at` (R back on the ratio scale), whether it wins there, and T2's harmful-side note. */
function partText(k, v, at, harmful) {
  if (v === null) return `${k} no verdict`;
  const body = k === 'a' ? `${f3(Math.exp(v.estimate))} [${f3(Math.exp(v.bounds[at].low))}, ${f3(Math.exp(v.bounds[at].high))}] t(${Number(v.df.toFixed(1))})` : codedText(v, at);
  return `${k} ${PART_NAMES[k]} ${body} (${eachView(v).every((x) => x.win[at]) ? 'win' : 'no win'}${harmful ? ', harmful side' : ''})`;
}

/** T1, T2 and T3 with their verdicts, then a line for each part or test the run did not reach and for each miss or cap branch.
 * T2's p is printed and decides nothing; T3 ends on the sentence its verdict allows. */
export function testLinesR4(design, scored, windows) {
  const { closed, views, edges } = scored;
  const knife = (name) => (edges[name] ? KNIFE : '');
  const one = (name, at, tail) => {
    if (!windows[name].reached) return belowCount(name, windows[name]);
    const v = closed[name];
    if (v.verdict === NO_VERDICT) return `${name} no verdict (${v.reason})`;
    return `${name} ${v.verdict}, p ${pText(views[name])}: ${codedText(views[name], at)}${knife(name)}${tail(v)}`;
  };
  const t2 = closed.T2;
  const t2Line = t2.verdict === NO_VERDICT ? `T2 no verdict (${t2.reason})`
    : `T2 ${t2.verdict} (read at ${t2.readAt}), p ${f3(t2.p)} (decides nothing): ${Object.keys(PART_NAMES).map((k) => partText(k, views.T2[k], t2.readAt, t2.parts[k].harmfulSide)).join('; ')}${knife('T2')}`;
  const sentence = (v) => (v.verdict === 'win' ? `; ${LESSONS_SENTENCE}` : `; ${BEHAVIOUR_SENTENCE}`);
  const cut = Object.keys(PART_NAMES).map((k) => `T2${k}`).filter((t) => !windows[t].reached).map((t) => belowCount(t, windows[t]));
  const ran = Object.entries(windows).filter(([, w]) => w.branch !== 'rule').map(([t, w]) => `${t} ran at ${w.n} seeds by the ${w.branch} branch; power ${f3(w.power)}`);
  return [one('T1', '0.05', () => ''), t2Line, one('T3', t2.readAt ?? '0.025', sentence), ...cut, ...ran];
}

const ratioText = (b) => (b.ratio === undefined ? `no estimate (${b.reason})` : `${f3(b.ratio)} [${f3(b.low)}, ${f3(b.high)}]`);
const holdsOne = (b) => b.low <= 1 && 1 <= b.high;
const noChange = (b) => (holdsOne(b) ? '; no change shown' : '');
const WORSE = (arm) => `${arm} did worse than round 3's Opus arm on the same tasks, so the Opus bars in parts (b) and (c) were easier to meet than round 3's Opus would make them.`;
const S1_SENTENCES = {
  pass: 'In an exploratory read, Sonnet alone also stayed inside the Opus bars on these tasks.',
  'no pass': 'In an exploratory read, Sonnet alone did not pass the same test. This read does not test whether hippo made the difference.',
};

function driftLines(d) {
  if (d.shared === 0) return [`  ${d.arm} drift: no shared tasks`];
  const head = `  ${d.arm} drift, ${d.arm} minus round 3's Opus arm on ${d.shared} shared tasks (raw records, no regrade)`;
  const line = `${head}: resolve ${est(d.resolve)}; first-apply repeats violation ${est(d.repeats.violation)}, excluded ${est(d.repeats.excluded)}; cost per solved task at the Opus row ${ratioText(d.cost)}; no verdict${noChange(d.cost)}`;
  return d.worse ? [line, WORSE(d.arm)] : [line];
}

function s1Lines(s1, design) {
  const label = pairOf(design, 'S1vO1').join(' against ');
  if (s1.verdict === NO_VERDICT) return [`${label}, exploratory: no verdict (a part has no estimate or its count was not reached)`];
  return [S1_SENTENCES[s1.verdict], `  ${label} at ${s1.threshold}: ${Object.keys(PART_NAMES).map((k) => partText(k, s1.parts[k], s1.threshold, false)).join('; ')}`];
}

function publishLines(p) {
  const arms = Object.entries(p.perArm);
  const rate = (r) => `${f3(r.violation)}/${f3(r.excluded)}`;
  const kind = (k) => `${f3(k.mean)} (${k.n})`;
  const families = [...new Set(CODINGS.flatMap((c) => Object.keys(p.families[c])))].sort();
  const both = (f) => CODINGS.map((c) => `${c} ${f3(p.families[c][f]?.mean)} (${p.families[c][f]?.units ?? 0})`).join(', ');
  return [
    'publish: repeat rate per arm, first applies and later applies (violation/excluded)',
    ...arms.map(([a, x]) => `  ${a} first applies ${rate(x.first)}; later applies ${rate(x.later)}`),
    'publish: cost per solved task per arm',
    ...arms.map(([a, x]) => `  ${a}: ${f3(x.costPerSolved)} per solved task`),
    'publish: cost by task kind, mean cost and count per arm',
    ...arms.map(([a, x]) => `  ${a}: teach ${kind(x.byKind.teach)}, first apply ${kind(x.byKind.firstApply)}, later apply ${kind(x.byKind.laterApply)}, set N ${kind(x.byKind.setN)}`),
    `publish: ${p.taught} against ${p.control} per family (mean and units, violation/excluded)`,
    ...families.map((f) => `  ${f}: ${both(f)}`),
  ];
}

function h4Line(h) {
  const [w, e] = [h.windows.H4, h.estimates.H4];
  if (!w.reached) return belowCount('H4', w);
  if (e === null) return 'H4 not run';
  return `H4 ${e.gate.pass ? 'pass' : 'FAIL'}: ${e.reason ?? `set N cost ratio ${est(e.costRatio)}; resolve difference ${est(e.resolveDiff)}`}`;
}

/** The round 4 block: the headline, the tests, the read-outs beside it (each no verdict), the S1 read, the drift and the publish list. */
function hypothesisLinesR4(h, rep, design) {
  const { readouts: r } = h;
  const [[treat, base], [, control], [alone]] = [pairOf(design, 'T2a'), pairOf(design, 'H3'), pairOf(design, 'S1vO1')];
  const [h3, h3Same] = isString(rep.H3) ? [rep.H3, ''] : [est(rep.H3), noChange(rep.H3)];
  const pooled = Number.isFinite(r.pooled) ? (100 * r.pooled).toFixed(1) : 'n/a';
  return [
    ...h.notes.map((n) => `levels note: ${n}`), h.headline, ...testLinesR4(design, h.scored, h.windows), h4Line(h),
    `  R, ${treat} against ${base} with both arms priced at the Opus row (seeds 1 to ${r.seeds.R}): ${ratioText(r.R)}; no verdict${noChange(r.R)}`,
    `  H3, ${treat} against ${control}, cost per task: ${h3}; no verdict${h3Same}`,
    `  ${treat} against ${control} cost per solved task, each arm at its own row, every seed: ${ratioText(r.own)}; no verdict${noChange(r.own)}`,
    ...driftLines(h.drift),
    `  pooled task-level solve difference, ${treat} against ${base}, seeds 1 to ${r.seeds.pooled}: ${pooled} points, no verdict`,
    `  recorded spend per paired solve: ${[treat, base, alone].map((a) => `${a} ${usd(r.spendPerSolve[a])}`).join(', ')}; no verdict`,
    ...s1Lines(h.scored.s1, design), ...publishLines(h.publish),
  ];
}

export function renderText(r, design = DESIGNS.r3) {
  const lines = [`Z0 analysis, ${r.mode}${r.ofRecord ? '' : ` (not of record: ${r.iterations} resamples, seed ${r.seed})`}`, `status: ${r.status}`];
  if (r.designNotRun.length > 0) lines.push(`design not fully run: ${r.designNotRun.join(', ')} not planned`);
  lines.push(`abandoned: ${r.abandoned.length === 0 ? 'none' : r.abandoned.join(', ')}`);
  const first3 = (xs) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ', ...' : ''}`;
  lines.push(`unchecked apply records (teach cell missing or invalid): ${r.unchecked.length === 0 ? 'none' : `${r.unchecked.length} (${first3(r.unchecked)})`}`);
  lines.push(`untaught-apply drops: ${r.untaughtApplyDrops} positions`);
  lines.push(`hook-voided: ${r.hookVoided} positions`);
  const grouped = new Map();
  for (const w of r.warnings) {
    const [where, message] = [w.slice(0, w.indexOf(': ')), w.slice(w.indexOf(': ') + 2)];
    grouped.set(message, [...(grouped.get(message) ?? []), where]);
  }
  for (const [message, wheres] of grouped) lines.push(`warning, ${wheres.length} records: ${message} (${first3(wheres)})`);
  for (const [k, c] of Object.entries(r.counts)) {
    lines.push(`${k}: ${c.records} records of ${c.planned} planned; voids ${c.voids} (${pct(c.voidShare)}), invalid ${c.invalid} (${pct(c.invalidShare)}), missing ${c.missing} (${pct(c.missingShare)}), abandoned tail ${c.abandoned}`);
  }
  lines.push(`void reasons: ${JSON.stringify(r.voids)}`);
  if (r.gates !== null) lines.push(...gateLines(r));
  // Holds no arm, so it prints in blind mode too; reported only, prereg 179 sets no gate on it.
  const s = r.storedSample;
  if (s) lines.push(`stored sample (179): agreement ${f3(s.agreement)} [${f3(s.ci95?.[0])}, ${f3(s.ci95?.[1])}], kappa ${f3(s.kappa)}, n ${s.n}`);
  if (r.gates !== null) lines.push(r.invalid.length === 0 ? 'valid: every gate passes' : `invalid: ${r.invalid.join(', ')}`);
  if (isString(r.hypotheses)) lines.push(r.hypotheses);
  else {
    const reported = reportedLines(r.reported, design);
    lines.push(...(isRound4Design(design) ? hypothesisLinesR4(r.hypotheses, r.reported, design) : hypothesisLines(r.hypotheses)), ...reported);
  }
  lines.push('sha256:', ...r.hashes.map((h) => `  ${h.sha256}  ${h.role} ${h.file}`));
  return `${lines.join('\n')}\n`;
}

/** The hash rows beyond the main inputs, each only when its flag is set, in the order the plan names them. */
const extraRows = (args) => [
  ...args.levels.map((f) => ['levels', f]), ['seed-rule', args.seedRule], ['read-set', args.readSet], ...args.mergeManifest.map((f) => ['merge-manifest', f]), ['pins', args.pins],
  ...args.driftRuns.map((f) => ['drift-runs', f]), ...args.driftPlan.map((f) => ['drift-plan', f]), ...args.ledgerRuns.map((f) => ['ledger-runs', f]),
].filter(([, f]) => f !== null);

/** The whole CLI as a function of argv and cwd, so tests drive it without a child process. */
export function runCli(argv, cwd = process.cwd()) {
  const fail = (code, message) => ({ code, stdout: '', stderr: `${message}\n` });
  let args;
  let inputs;
  let analysis;
  let hashes;
  let codes = null;
  try {
    args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    args = expandReadSet(args, cwd);
    inputs = loadInputs(args, cwd);
    const spend = () => spendByArm({ runs: args.ledgerRuns.map((f) => path.resolve(cwd, f)), prices: inputs.prices, design: inputs.design, pricesFile: args.prices });
    analysis = analyzeZ0(inputs.records, { ...inputs, iterations: args.iterations ?? ITERATIONS, seed: args.seed ?? SEED, unblind: args.unblind, refuse: (gates) => unblindRefusal(args, gates, cwd), spend });
    if (analysis.refusal !== null) return fail(2, `unblind refused: ${analysis.refusal}`);
    // Before the blind key is written, so a failed hash leaves no key behind.
    hashes = inputHashes(args, cwd, { extra: extraRows(args) });
    if (!args.unblind) codes = loadOrCreateKey(args.key === null ? path.join(path.dirname(path.resolve(cwd, args.runs[0])), 'z0-blind-key.json') : path.resolve(cwd, args.key), analysis.filtered.arms);
  } catch (e) {
    return fail(1, e.message);
  }
  const report = buildReport(analysis, inputs, args, codes, hashes);
  try {
    if (args.out !== null) fs.writeFileSync(path.resolve(cwd, args.out), `${JSON.stringify(report, null, 2)}\n`);
  } catch (e) {
    return fail(1, `--out ${args.out}: ${e.message}`);
  }
  return { code: 0, stdout: renderText(report, inputs.design), stderr: '' };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
