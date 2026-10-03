#!/usr/bin/env node
/** Z0 analyzer, part 6 of 6: `analyzeZ0` composes contract, filters, gates and hypotheses; the CLI reads files and reports.
 * Usage and readings: docs/evals/2026-10-03-z0-analyzer.md. Exit 0 on a report (invalid runs too), 1 on bad input, 2 on a refused unblind. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEALED, blindView, inputHashes, loadOrCreateKey, unblindRefusal } from './z0-blind.mjs';
import { filterRecords } from './z0-filters.mjs';
import { computeGates } from './z0-gates.mjs';
import { NOT_RUN, computeHypotheses, computeReported } from './z0-hypotheses.mjs';
import { ALL_ARMS, isString, parsePlan, parseZ0Records, validateCorpus } from './z0-records.mjs';

export const ITERATIONS = 10_000;
export const SEED = 1;
export const ABANDONED = 'abandoned';
export const NOT_ANALYSED = 'not analysed: the run is abandoned (prereg 114)';
const USAGE = 'usage: z0-analyze.mjs --runs FILE [--runs FILE ...] --plan FILE [--plan FILE ...] --prices FILE [--grading FILE] [--drop-list FILE] [--key FILE] [--unblind] [--seed N --iterations N] [--out FILE]';
const SINGLE = new Map([['--prices', 'prices'], ['--grading', 'grading'], ['--drop-list', 'dropList'], ['--key', 'key'], ['--out', 'out'], ['--seed', 'seed'], ['--iterations', 'iterations']]);
const PRICE_FIELDS = ['inputPerMTok', 'cacheWritePerMTok', 'cacheReadPerMTok', 'outputPerMTok'];

/** Registered arms and sets the plan left out (reading 11), both read from the plan; "not run" must not read as the registered design. */
export function unplannedDesign(filtered) {
  const arms = ALL_ARMS.filter((a) => !filtered.arms.includes(a));
  const sets = ['R', 'N', 'X'].filter((s) => !filtered.sets.includes(s)).map((s) => `set ${s}`);
  return [...arms, ...sets];
}

/** Validation, filters and gates; the hypothesis and reported blocks only when unblinding is allowed and every gate passes.
 * An abandoned run is never analysed (114): no gates, no hypotheses, and its codes stay closed. */
export function analyzeZ0(records, opts) {
  const { unchecked } = validateCorpus(records, opts.planCells);
  const filtered = filterRecords(records, opts.planCells, { grading: opts.grading ?? null, dropList: opts.dropList ?? null });
  const unplanned = unplannedDesign(filtered);
  if (filtered.abandoned.length > 0) {
    const refusal = opts.unblind ? 'the run is abandoned and never analysed (prereg 114), so its codes stay closed' : null;
    return { status: ABANDONED, unchecked, filtered, unplanned, gates: null, refusal, hypotheses: null, reported: null };
  }
  const stat = { iterations: opts.iterations ?? ITERATIONS, seed: opts.seed ?? SEED };
  const gates = computeGates(records, filtered, opts.grading ?? null, stat);
  const refusal = opts.unblind ? (opts.refuse?.(gates) ?? null) : null;
  const open = opts.unblind === true && refusal === null && gates.pass;
  return {
    status: gates.pass ? 'valid' : 'invalid', unchecked, filtered, unplanned, gates, refusal,
    hypotheses: open ? computeHypotheses(filtered, opts.prices, stat) : null,
    reported: open ? computeReported(records, filtered, opts.prices, stat) : null,
  };
}

export function parseArgs(argv) {
  const args = { runs: [], plan: [], prices: null, grading: null, dropList: null, key: null, out: null, seed: null, iterations: null, unblind: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...args, help: true };
    if (flag === '--unblind') {
      args.unblind = true;
      continue;
    }
    const value = argv[++i];
    if (!isString(value) || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (flag === '--runs' || flag === '--plan') args[flag.slice(2)].push(value);
    else if (!SINGLE.has(flag)) throw new Error(`unknown flag ${flag}\n${USAGE}`);
    else if (args[SINGLE.get(flag)] !== null) throw new Error(`${flag} given twice`);
    else args[SINGLE.get(flag)] = value;
  }
  for (const k of ['seed', 'iterations']) {
    if (args[k] === null) continue;
    args[k] = Number(args[k]);
    if (!Number.isInteger(args[k]) || args[k] < 1) throw new Error(`--${k} must be a positive integer`);
  }
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
const isPrices = (p) => p !== undefined && p !== null && PRICE_FIELDS.every((f) => Number.isFinite(p[f]) && p[f] >= 0);

/** Reads every input file and rejects a malformed one by name; records keep their file and line. */
export function loadInputs(args, cwd) {
  const records = [];
  const warnings = [];
  for (const f of args.runs) {
    const parsed = parseZ0Records(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f);
    records.push(...parsed.records);
    warnings.push(...parsed.warnings);
  }
  const planCells = args.plan.flatMap((f) => parsePlan(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f));
  const prices = readJson(cwd, args.prices);
  if (!isPrices(prices['claude-code']) || !(prices.codex === undefined || isPrices(prices.codex))) {
    throw new Error(`${args.prices}: needs "claude-code" (and optionally "codex") with ${PRICE_FIELDS.join(', ')}`);
  }
  const grading = args.grading === null ? null : readJson(cwd, args.grading);
  if (grading !== null && !(isNames(grading.flippedLessons) && isCount(grading.acceptanceFlips) && isCount(grading.readerSample?.n) && isCount(grading.readerSample?.disagreements))) {
    throw new Error(`${args.grading}: needs flippedLessons (strings), acceptanceFlips and readerSample { n, disagreements } (integers)`);
  }
  const dropList = args.dropList === null ? null : readJson(cwd, args.dropList);
  if (dropList !== null && !(isNames(dropList.droppedLessons) && isNames(dropList.droppedFamilies))) {
    throw new Error(`${args.dropList}: needs droppedLessons and droppedFamilies (strings)`);
  }
  return { records, warnings, planCells, prices, grading, dropList };
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
    untaughtApplyDrops: analysis.filtered.untaughtApplyDrops, warnings: inputs.warnings,
    counts: view.perCode, voids, gates: view.gates, invalid: abandoned ? null : analysis.gates.failed,
    hypotheses, reported: abandoned ? NOT_ANALYSED : blind ? SEALED : analysis.reported, hashes,
  };
}

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const est = (e) => (isString(e) ? e : `${f3(e.estimate)} [${f3(e.low)}, ${f3(e.high)}]`);
const pairText = (p) => (isString(p) ? p : `violation ${est(p.violation)} (${p.violation.units} units); excluded ${est(p.excluded)} (${p.excluded.units} units)`);

function gateLines(r) {
  const g = r.gates;
  const half = (h) => (h.status === NOT_RUN ? `not run${h.required ? ' but required' : ''}` : `${h.status}, ${pairText(h)}`);
  const worst = Object.values(g.G4.perArm).reduce((m, a) => Math.max(m, a.share), 0);
  return [
    `G1 ${g.G1.pass ? 'pass' : 'fail'}: ${g.G1.operatorCanaries} operator canaries; void share ${Object.entries(g.G1.perArm).map(([k, v]) => `${k} ${pct(v.share)}`).join(', ')}`,
    `G2 ${g.G2.pass ? 'pass' : 'fail'}: Claude Code half ${half(g.G2.claudeCode)}; Codex half ${half(g.G2.codex)}`,
    `G3 ${g.G3.pass ? 'pass' : 'fail'}: ${g.G3.leaked} of ${g.G3.plannedRuns} planned (sequence, seed)s leaked`,
    `G4 ${g.G4.pass ? 'pass' : 'fail'}: worst invalid-or-missing share ${pct(worst)}, gap ${(100 * g.G4.gap).toFixed(1)} points`,
    `G5 ${g.G5.pass ? 'pass' : `fail (${g.G5.status})`}${g.G5.n === undefined ? '' : `: ${g.G5.disagreements} of ${g.G5.n} reader-sampled grades disagree; flipped lessons ${g.G5.flippedLessons}, acceptance flips ${g.G5.acceptanceFlips}`}`,
  ];
}

function hypothesisLines(h) {
  const lines = [];
  for (const name of h.order) {
    if (name === 'H4') {
      const g = h.H4;
      if (isString(g)) lines.push(`H4 ${g}`);
      else lines.push(`H4 ${g.gate.pass ? 'pass' : 'FAIL'}: ${g.reason ?? `set N cost ratio ${est(g.costRatio)}, resolve difference ${est(g.resolveDiff)}`}`);
    } else if (name === 'attribution') {
      const a = h.attribution;
      lines.push(isString(a) ? `attribution ${a}` : `attribution: ${a.sentence ?? a.reason}; A2 vs A5 ${a.violation === undefined ? NOT_RUN : pairText(a)}`);
    } else {
      const v = h.verdicts[name];
      const small = v.final.verdict === 'win' && !v.final.reachesMinimum ? ' (small win)' : '';
      const ps = v.violation ? `, adjusted p ${f3(v.violation.adjustedP)} / ${f3(v.excluded.adjustedP)}` : '';
      const detail = name === 'H3' && !isString(h.H3)
        ? `ratio ${est(h.H3)}; first session ${est(h.H3.firstSession)}, extra turns ${est(h.H3.extra)}; retry-voided positions ${pct(h.H3.retryVoidedShare)}`
        : pairText(h[name]);
      lines.push(`${name} ${v.final.verdict}${small}${ps}: ${detail}`);
    }
  }
  return lines;
}

function reportedLines(rep) {
  const lines = ['reported, no verdicts:'];
  for (const k of ['A1vA0', 'A4vA1', 'X2vX1']) lines.push(`  ${k}: ${pairText(rep[k])}`);
  for (const [arm, a] of Object.entries(rep.perArm)) lines.push(`  ${arm}: ${a.tasks} tasks, resolve ${est(a.resolveRate)}, cost per resolved ${est(a.costPerResolved)}, stale-follow ${est(a.staleFollow)}`);
  lines.push(`  maintainer only: H1 ${pairText(rep.maintainerOnly.H1)}; H2 ${pairText(rep.maintainerOnly.H2)}; H3 ${est(rep.maintainerOnly.H3)}`);
  lines.push(`  first apply only: H1 ${pairText(rep.firstApply.H1)}`);
  const rate = (e) => (isString(e) ? e : f3(e.estimate));
  for (const [bucket, p] of Object.entries(rep.bySinceTeach)) {
    const seeds = (r) => (r.seeds.length === 0 ? '' : ` (seeds ${r.seeds.join(',')})`);
    const rates = Object.entries(rep.ratesBySinceTeach[bucket]).map(([arm, r]) => `${arm} ${rate(r.violation)}/${rate(r.excluded)}${seeds(r)}`);
    lines.push(`  tasksSinceTeach ${bucket}: A2 - A1 ${pairText(p)}; rates (violation/excluded) ${rates.join(', ')}`);
  }
  const wo = rep.wordOverlap;
  lines.push(`  wordOverlap Spearman: ${isString(wo) ? wo : `violation ${est(wo.violation)}; excluded ${est(wo.excluded)}`}`);
  const s = rep.sensitivity;
  lines.push(`  without ${s.carryUnionRuns} carry-union runs: H1 ${pairText(s.H1)}; H3 ${est(s.H3)}; ${s.retryVoidedPositions} positions voided by unrestored retries`);
  lines.push('  rotation slots and the memory-failure chain: see --out');
  return lines;
}

export function renderText(r) {
  const lines = [`Z0 analysis, ${r.mode}${r.ofRecord ? '' : ` (not of record: ${r.iterations} resamples, seed ${r.seed})`}`, `status: ${r.status}`];
  if (r.designNotRun.length > 0) lines.push(`design not fully run: ${r.designNotRun.join(', ')} not planned`);
  lines.push(`abandoned: ${r.abandoned.length === 0 ? 'none' : r.abandoned.join(', ')}`);
  const first3 = (xs) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ', ...' : ''}`;
  lines.push(`unchecked apply records (teach cell missing or invalid): ${r.unchecked.length === 0 ? 'none' : `${r.unchecked.length} (${first3(r.unchecked)})`}`);
  lines.push(`untaught-apply drops: ${r.untaughtApplyDrops} positions`);
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
  if (r.gates !== null) lines.push(...gateLines(r), r.invalid.length === 0 ? 'valid: every gate passes' : `invalid: ${r.invalid.join(', ')}`);
  if (isString(r.hypotheses)) lines.push(r.hypotheses);
  else lines.push(...hypothesisLines(r.hypotheses), ...reportedLines(r.reported));
  lines.push('sha256:', ...r.hashes.map((h) => `  ${h.sha256}  ${h.role} ${h.file}`));
  return `${lines.join('\n')}\n`;
}

/** The whole CLI as a function of argv and cwd, so tests drive it without a child process. */
export function runCli(argv, cwd = process.cwd()) {
  const fail = (code, message) => ({ code, stdout: '', stderr: `${message}\n` });
  let args;
  let inputs;
  let analysis;
  let codes = null;
  try {
    args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    inputs = loadInputs(args, cwd);
    analysis = analyzeZ0(inputs.records, { ...inputs, iterations: args.iterations ?? ITERATIONS, seed: args.seed ?? SEED, unblind: args.unblind, refuse: (gates) => unblindRefusal(args, gates, cwd) });
    if (analysis.refusal !== null) return fail(2, `unblind refused: ${analysis.refusal}`);
    if (!args.unblind) codes = loadOrCreateKey(args.key === null ? path.join(path.dirname(path.resolve(cwd, args.runs[0])), 'z0-blind-key.json') : path.resolve(cwd, args.key), analysis.filtered.arms);
  } catch (e) {
    return fail(1, e.message);
  }
  const report = buildReport(analysis, inputs, args, codes, inputHashes(args, cwd));
  if (args.out !== null) fs.writeFileSync(path.resolve(cwd, args.out), `${JSON.stringify(report, null, 2)}\n`);
  return { code: 0, stdout: renderText(report), stderr: '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
