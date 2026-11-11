#!/usr/bin/env node
/** Z0 round 4 budget (prereg item 12): the spend projection, the one admission check every paid scope passes before it starts, and the log of those checks.
 * Exit 0 on a pass, 1 on an input error or a started scope, and per step 3, 4, 5 or 6 on a refusal. */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARM_TABLE, DESIGNS, OPUS_MODEL } from './arms.mjs';
import { appendJsonLine, readSealed, writeFileAtomic } from './atomic-write.mjs';
import { PILOT_SCHEMA, SEED_CAP, SEED_PREVIEW_SCHEMA, SEED_RULE_SCHEMA, SPEND_BASIS_SCHEMA, parsePlan } from './z0-records.mjs';

/** Round 4's approved figure (prereg decision 5); a larger --approved needs a founder go that names it. */
export const APPROVED_FIGURE = 2140;
/** The pilot's own budget (prereg item 11); the pilot admit's cap and the figure `project` adds as the pilot. */
export const PILOT_BUDGET = 40;
export const GATE_MARGIN = 1.25;
// Prereg item 12: round 3's q145 run lost most of its records to the shared-venv break, so its spend is replaced by the other keys' mean.
const GAP_SEQUENCE = 'q145';
const R4_ARMS = DESIGNS.r4.arms;
const RULE_ARMS = R4_ARMS.filter((a) => ARM_TABLE[a].seedRule);
export const BASE_SEEDS = ARM_TABLE[RULE_ARMS[0]].seeds;
const AT_R = 2;
// The pilot's r at which prereg item 12 names the arm to the founder.
export const R_FLAG = 1.9;
const USAGE = 'usage: z0-budget.mjs admit --step <smoke|pilot|whole-run|batch-1|batch-2|seeds> --attempt <n> --approved <usd> --ledger-total <usd> --spend-basis <f> --pins <f> --log <f>\n'
  + '         [--units <folder>: repeat the flag once per folder] [--plans <f>: repeat the flag once per plan] [--warmups <dir>] [--pilot <f>] [--scale <f>] [--seed-preview <f>] [--seed-rule <f>] [--seal <f>] [--mark <f>]\n'
  + '         [--cap-only --attempt-ledger <usd>]\n'
  + '       z0-budget.mjs scale --batch1-ledger <usd> --spend-basis <f> --pins <f> --pilot <f> --out <f>\n'
  + '         (--batch1-ledger is the ledger over batch 1\'s unit folders only, so the pilot stays out)\n'
  + '       z0-budget.mjs founder-go --question <whole-run|power|pilot|figure> [--figure <usd>: figure and pilot need it unless --stop] [--attempt <n>: pilot needs it] [--stop] --words "<text>" --log <f>\n'
  + '       z0-budget.mjs report --log <f> --ledger-total <usd> --approved <usd> --pins <f> [--pilot <f>] [--stopped <id> --step <step>]\n'
  + '       z0-budget.mjs project --spend-basis <f> --pins <f>\n'
  + 'exit 0 pass, 1 input error, 3 or 4 or 5 or 6 a refusal named by its line';

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const money = (x) => x.toFixed(2);

/* ------------------------------------------------------------------------------------------ projection */

/** Item 12's projection: O1 at its twin's spend, a Sonnet arm at its twin's spend times 0.5 x r, each scaled by its seeds over its base seeds, times `scale`, plus the pilot once.
 * The two spend maps are keyed by round 3 codes, as the spend basis holds them; `seedsByArm` overrides an arm's base seeds. */
export function projectSpend({ basisByArm, gapByArm = {}, r, seedsByArm = {}, pilotUsd = 0, scale = 1 }) {
  const arms = R4_ARMS.map((a) => {
    const { twin, seeds, model } = ARM_TABLE[a];
    const spend = basisByArm[twin];
    if (!Number.isFinite(spend)) throw new Error(`projectSpend: basisByArm has no spend for ${twin}, the twin of ${a}`);
    return (spend + (gapByArm[twin] ?? 0)) * (model === OPUS_MODEL ? 1 : 0.5 * r) * ((seedsByArm[a] ?? seeds) / seeds) * scale;
  });
  return pilotUsd + sum(arms);
}

/** The whole run after the pilot: every arm at base seeds with q145's gap, the rule arms at `seeds`. */
export function wholeRun({ basisByArm, gapByArm, r, seeds }) {
  return projectSpend({ basisByArm, gapByArm, r, seedsByArm: Object.fromEntries(RULE_ARMS.map((a) => [a, seeds])) });
}

/** Per arm, the other batch 1 keys' mean spend minus q145's own. */
export function sequenceGap(bySequence, batch1Keys) {
  for (const k of [GAP_SEQUENCE, ...batch1Keys]) if (bySequence[k] === undefined) throw new Error(`sequenceGap: bySequence has no row for ${k}`);
  const others = batch1Keys.filter((k) => k !== GAP_SEQUENCE);
  if (others.length === batch1Keys.length) throw new Error(`sequenceGap: the batch 1 keys ${batch1Keys.join(',')} do not hold ${GAP_SEQUENCE}`);
  if (others.length === 0) throw new Error(`sequenceGap: batch 1 holds ${GAP_SEQUENCE} alone, so there is no mean to take`);
  return Object.fromEntries(Object.keys(bySequence[GAP_SEQUENCE]).map((arm) => [arm, sum(others.map((k) => bySequence[k][arm])) / others.length - bySequence[GAP_SEQUENCE][arm]]));
}

/** Sessions at the mean cost per record, and one warm-up per model of each plan's Claude Code arms (the runner's warm-up call, one per model per run). */
export function stepProjection({ plans, meanPerRecord, warmupUsd }) {
  const sessions = sum(plans.map((p) => p.length));
  const warmups = sum(plans.map((p) => new Set(p.map((c) => ARM_TABLE[c.arm]).filter((row) => row.tool === 'claude-code').map((row) => row.model)).size));
  return sessions * meanPerRecord + warmups * (warmupUsd ?? meanPerRecord);
}

/** The one check: ledger + margin x projection fits the figure, and where the step has a cap, capSpend + projection fits it; a null figure or cap skips that test. */
export function admissionOk({ ledger, projection, margin, figure, cap, capSpend }) {
  const figureOk = figure === null || figure === undefined || ledger + margin * projection <= figure;
  const capOk = cap === null || cap === undefined || (capSpend ?? 0) + projection <= cap;
  return figureOk && capOk;
}

/** Which test of `admissionOk` failed: the figure first, then the cap; null when both hold. */
function refusalOf(check) {
  if (!admissionOk({ ...check, cap: null })) return 'figure';
  return admissionOk({ ...check, figure: null }) ? null : 'cap';
}

/** The rule arms' extra seeds at j: each rule arm to min(count, j) seeds less its base, every other arm 0. */
const raiseSeeds = (counts, j) => Object.fromEntries(R4_ARMS.map((a) => [a, RULE_ARMS.includes(a) ? Math.max(0, Math.min(counts[a], j) - BASE_SEEDS) : 0]));

function sumsOver(bySequence, keys) {
  for (const k of keys) if (bySequence[k] === undefined) throw new Error(`the spend basis has no bySequence row for ${k}`);
  return Object.fromEntries(Object.keys(bySequence[keys[0]]).map((arm) => [arm, sum(keys.map((k) => bySequence[k][arm]))]));
}

/** Batch 1's projection at scale 1: its keys' round 3 spend with q145's gap, since round 4 runs all of q145's sessions. */
function batch1Spend(basis, pins, r) {
  const keys = listOf(pins, 'batch1Keys');
  return projectSpend({ basisByArm: sumsOver(basis.bySequence, keys), gapByArm: sequenceGap(basis.bySequence, keys), r });
}

/* ------------------------------------------------------------------------------------------------ inputs */

const usage = (message) => new Error(`${message}\n${USAGE}`);

function readJson(file, what) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${what} ${file} cannot be read: ${err.message}`, { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what} ${file} is not JSON: ${err.message}`, { cause: err });
  }
}

function readSchema(file, what, schema) {
  const body = readJson(file, what);
  if (body?.schema !== schema) throw new Error(`${what} ${file}: schema is ${body?.schema}, not ${schema}`);
  return body;
}

export function readBasis(file) {
  const basis = readSchema(file, 'spend basis', SPEND_BASIS_SCHEMA);
  if (!Number.isFinite(basis.meanPerRecord) || basis.meanPerRecord <= 0) throw new Error(`spend basis ${file}: meanPerRecord must be a number above 0`);
  return basis;
}

/** The six checks z0-pilot writes; an admit reads a pilot only when every one passed. */
export const PILOT_CHECKS = Object.freeze(['off-pin', 'effort', 'venv', 'env-keys', 'cost-usd', 'r']);

// A failed pilot (rMax null, or any check not passed) still prints in report; every admit refuses it.
function readPilot(file, { needR = true } = {}) {
  const pilot = readSchema(file, 'pilot', PILOT_SCHEMA);
  if (!needR) return pilot;
  if (!Number.isFinite(pilot.rMax) || pilot.rMax <= 0) throw new Error(`pilot ${file}: rMax must be a number above 0`);
  const failed = PILOT_CHECKS.filter((id) => pilot.checks?.[id] !== 'pass');
  if (failed.length > 0) throw new Error(`pilot ${file}: checks not passed: ${failed.join(', ')}`);
  return pilot;
}

/** The pins file's parsed body and the sha256 of its bytes; `z0-pins-check --write` stores every value as a string. */
export function readPins(file) {
  const bytes = fs.readFileSync(file);
  try {
    return { ...JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (err) {
    throw new Error(`pins ${file} is not JSON: ${err.message}`, { cause: err });
  }
}

/** A pins key list, held as an array or as one comma-separated string. */
export function listOf(pins, key) {
  if (pins[key] === undefined || pins[key] === null) throw new Error(`the pins file has no ${key}`);
  return String(pins[key]).split(',').map((s) => s.trim()).filter(Boolean);
}

export function wholeRunSeeds(pins) {
  const n = Number(pins.wholeRunSeeds);
  if (!Number.isInteger(n) || n < BASE_SEEDS || n > SEED_CAP) throw new Error(`the pins file's wholeRunSeeds ${pins.wholeRunSeeds} is not a whole number from ${BASE_SEEDS} to ${SEED_CAP}`);
  return n;
}

function readScale(file) {
  const sealed = readSealed(file);
  if (sealed === null) throw new Error(`${file} is absent: batch 1's end phase seals it, and a later check reads it`);
  if (!(sealed.scale > 0)) throw new Error(`${file}: scale must be a number above 0`);
  return sealed.scale;
}

/** The founder gos and admit entries of the budget log, in order; a torn last line is left out, as `appendJsonLine` drops it. */
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`${file} line ${i + 1} is not JSON: ${err.message}`, { cause: err });
    }
  });
}

/** The pilot's warm-up cost: the largest total_cost_usd over the <model>.json files, never the .start.json ones. */
function warmupCost(dir) {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.start.json'));
  if (files.length === 0) throw new Error(`${dir} holds no <model>.json warm-up file`);
  return Math.max(...files.map((n) => {
    const cost = readJson(path.join(dir, n), 'warm-up').total_cost_usd;
    if (!Number.isFinite(cost)) throw new Error(`warm-up ${path.join(dir, n)} has no total_cost_usd`);
    return cost;
  }));
}

/* ------------------------------------------------------------------------------------------------ arguments */

const COMMANDS = new Set(['admit', 'scale', 'founder-go', 'report', 'project']);
const VALUE_FLAGS = new Set(['--step', '--attempt', '--approved', '--ledger-total', '--batch1-ledger', '--spend-basis', '--pins', '--log', '--warmups', '--pilot', '--scale', '--seed-preview',
  '--seed-rule', '--seal', '--mark', '--attempt-ledger', '--out', '--question', '--figure', '--words', '--stopped']);
const LIST_FLAGS = new Set(['--units', '--plans']);
const SWITCHES = new Set(['--cap-only', '--stop']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) throw usage(`unknown command ${command ?? '(none)'}`);
  const flags = new Map();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (SWITCHES.has(flag)) {
      flags.set(flag, true);
      continue;
    }
    if (!VALUE_FLAGS.has(flag) && !LIST_FLAGS.has(flag)) throw usage(`unknown flag ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw usage(`${flag} needs a value`);
    if (LIST_FLAGS.has(flag)) flags.set(flag, [...(flags.get(flag) ?? []), value]);
    else if (flags.has(flag)) throw usage(`${flag} given twice`);
    else flags.set(flag, value);
  }
  return { command, flags };
}

const need = ({ command, flags }, flag) => {
  if (!flags.has(flag)) throw usage(`${command} needs ${flag}`);
  return flags.get(flag);
};
const optional = ({ flags }, flag) => flags.get(flag) ?? null;
const listFlag = ({ flags }, flag) => flags.get(flag) ?? [];
const filePath = (args, flag, cwd) => path.resolve(cwd, need(args, flag));

function usdFlag(args, flag) {
  const raw = need(args, flag);
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) throw usage(`${flag} ${raw} is not a USD figure`);
  return n;
}

function countFlag(args, flag) {
  const n = Number(need(args, flag));
  if (!Number.isInteger(n) || n < 1) throw usage(`${flag} ${need(args, flag)} is not a whole number from 1`);
  return n;
}

const answer = (code, stdout = '', stderr = '') => ({ code, stdout: stdout === '' ? '' : `${stdout}\n`, stderr: stderr === '' ? '' : `${stderr}\n` });

/* ------------------------------------------------------------------------------------------------ admit */

const STEPS = new Set(['smoke', 'pilot', 'whole-run', 'batch-1', 'batch-2', 'seeds']);
const SCOPES = { smoke: 'the smoke', pilot: 'the pilot', 'whole-run': 'batch 1', 'batch-1': 'batch 1', 'batch-2': 'batch 2', seeds: 'the raise' };
const UNIT_NAME = /^(.+?)-(?:w|e)\d+(?:-a\d+)?$/;

/** The key of each unit folder, `<k>-w<n>` or `<k>-e<s>` with an optional `-a<m>`, each key once and in the order named. */
function unitKeys(units) {
  const keys = units.map((u) => {
    const m = UNIT_NAME.exec(path.basename(u));
    if (m === null) throw new Error(`admit: unit folder ${path.basename(u)} is not <key>-w<n> or <key>-e<s>, with an optional -a<m>`);
    return m[1];
  });
  return [...new Set(keys)];
}

function checkKeys(units, pins, pinKey) {
  const [have, want] = [unitKeys(units), listOf(pins, pinKey)];
  if (have.length !== want.length || !have.every((k) => want.includes(k))) {
    throw new Error(`admit: --units hold the keys ${have.join(',')} but the pins file's ${pinKey} are ${want.join(',')}`);
  }
}

/** The founder's yes answers to one question, in order: a go logged with --stop is a stop, never a yes. */
const yesGos = (entries, question) => entries.filter((e) => e.kind === 'founder-go' && e.question === question && !e.stop);

/** Each rule arm's seed count from a seed rule or seed preview, a whole number from the base count to the cap. */
function ruleCounts(counts, what, file) {
  return Object.fromEntries(RULE_ARMS.map((a) => {
    const n = counts?.[a];
    if (!Number.isInteger(n) || n < BASE_SEEDS || n > SEED_CAP) throw new Error(`${what} ${file} has no seed count for ${a} from ${BASE_SEEDS} to ${SEED_CAP}`);
    return [a, n];
  }));
}

/** A step's inputs read once, and its projection with the margin, cap and scale it runs at. `figure` is false for a cap-only check. */
const PLANNERS = {
  smoke(args, cwd) {
    const basis = readBasis(filePath(args, '--spend-basis', cwd));
    const plans = listFlag(args, '--plans').map((f) => parsePlan(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f));
    if (plans.length === 0) throw usage('admit --step smoke needs --plans');
    return { projection: stepProjection({ plans, meanPerRecord: basis.meanPerRecord, warmupUsd: undefined }), margin: 1, cap: null, capSpend: 0, scale: 1, figure: true };
  },
  pilot(args, cwd, ctx) {
    const basis = readBasis(filePath(args, '--spend-basis', cwd));
    const plans = listFlag(args, '--plans').map((f) => parsePlan(fs.readFileSync(path.resolve(cwd, f), 'utf8'), f));
    if (plans.length === 0) throw usage('admit --step pilot needs --plans');
    const projection = stepProjection({ plans, meanPerRecord: basis.meanPerRecord, warmupUsd: warmupCost(filePath(args, '--warmups', cwd)) });
    const gos = yesGos(ctx.entries, 'pilot').filter((e) => e.attempt === ctx.attempt);
    const cap = Math.max(PILOT_BUDGET, gos.length === 0 ? 0 : gos.at(-1).figure);
    const capOnly = args.flags.has('--cap-only');
    return { projection, margin: 1, cap, capSpend: capOnly ? usdFlag(args, '--attempt-ledger') : 0, scale: 1, figure: !capOnly };
  },
  'whole-run'(args, cwd) {
    const pilotFile = filePath(args, '--pilot', cwd);
    const [basis, pins, pilot] = [readBasis(filePath(args, '--spend-basis', cwd)), readPins(filePath(args, '--pins', cwd)), readPilot(pilotFile)];
    const hot = hotArms(pilot, pilotFile);
    const gapByArm = sequenceGap(basis.bySequence, listOf(pins, 'batch1Keys'));
    const at = (seeds) => wholeRun({ basisByArm: basis.basisByArm, gapByArm, r: pilot.rMax, seeds });
    const seeds = wholeRunSeeds(pins);
    const lines = [`r ${pilot.rMax} from ${pilot.rArm}`, `projection at r ${pilot.rMax}, ${seeds} seeds: $${money(at(seeds))}`, `projection at r ${pilot.rMax}, ${SEED_CAP} seeds: $${money(at(SEED_CAP))}`];
    return { projection: at(seeds), margin: GATE_MARGIN, cap: null, capSpend: 0, scale: 1, figure: true, hot, lines };
  },
  'batch-1'(args, cwd) {
    const [basis, pins, pilot] = [readBasis(filePath(args, '--spend-basis', cwd)), readPins(filePath(args, '--pins', cwd)), readPilot(filePath(args, '--pilot', cwd))];
    checkKeys(listFlag(args, '--units'), pins, 'batch1Keys');
    return { projection: batch1Spend(basis, pins, pilot.rMax), margin: GATE_MARGIN, cap: null, capSpend: 0, scale: 1, figure: true };
  },
  'batch-2'(args, cwd) {
    const [basis, pins, pilot] = [readBasis(filePath(args, '--spend-basis', cwd)), readPins(filePath(args, '--pins', cwd)), readPilot(filePath(args, '--pilot', cwd))];
    const units = listFlag(args, '--units');
    checkKeys(units, pins, 'batch2Keys');
    const [scale, r] = [readScale(filePath(args, '--scale', cwd)), pilot.rMax];
    const preview = readSchema(filePath(args, '--seed-preview', cwd), 'seed preview', SEED_PREVIEW_SCHEMA);
    const counts = ruleCounts(preview.countsByArm, 'seed preview', args.flags.get('--seed-preview'));
    const base = projectSpend({ basisByArm: sumsOver(basis.bySequence, listOf(pins, 'batch2Keys')), r, scale });
    const raise = projectSpend({ basisByArm: basis.basisByArm, gapByArm: sequenceGap(basis.bySequence, listOf(pins, 'batch1Keys')), r, seedsByArm: raiseSeeds(counts, SEED_CAP), scale });
    // The gate adds the raise preview; the batch's own spend, the one `report` compares growth with, is the base term.
    return { projection: base + raise, ownProjection: base, margin: GATE_MARGIN, cap: null, capSpend: 0, scale, figure: true };
  },
};

/** The raise: j falls from the rule's largest count until the check passes, else 3 (the base count), whatever the ledger. */
function raisePlan(args, cwd, ctx) {
  const [basis, pins, pilot] = [readBasis(filePath(args, '--spend-basis', cwd)), readPins(filePath(args, '--pins', cwd)), readPilot(filePath(args, '--pilot', cwd))];
  const rule = readSchema(filePath(args, '--seed-rule', cwd), 'seed rule', SEED_RULE_SCHEMA);
  const counts = ruleCounts(rule.seeds, 'seed rule', args.flags.get('--seed-rule'));
  const [scale, k] = [readScale(filePath(args, '--scale', cwd)), Math.max(...Object.values(counts))];
  const gapByArm = sequenceGap(basis.bySequence, listOf(pins, 'batch1Keys'));
  const at = (j) => projectSpend({ basisByArm: basis.basisByArm, gapByArm, r: pilot.rMax, seedsByArm: raiseSeeds(counts, j), scale });
  let j = BASE_SEEDS;
  for (let tryJ = k; tryJ > BASE_SEEDS; tryJ--) {
    if (admissionOk({ ledger: ctx.ledger, projection: at(tryJ), margin: GATE_MARGIN, figure: ctx.approved, cap: null, capSpend: 0 })) {
      j = tryJ;
      break;
    }
  }
  return { projection: at(j), margin: GATE_MARGIN, cap: null, capSpend: 0, scale, figure: true, maxSeed: j, count: k };
}

/** The arms of the pilot's r at the flag, as [arm, r] pairs. The pilot file's flag19 must say the same, or the file was changed by hand. */
function hotArms(pilot, file) {
  const hot = Object.entries(pilot.r ?? {}).filter(([, r]) => r >= R_FLAG);
  if ((hot.length > 0) !== (pilot.flag19 === true)) {
    throw new Error(`pilot ${file}: flag19 is ${pilot.flag19}, but pilot.r gives ${hot.length > 0} (any arm at ${R_FLAG} or more): ${JSON.stringify(pilot.r)}`);
  }
  return hot;
}

/** The refusal each step and reason takes: its exit code and its line. */
const REFUSALS = {
  smoke: { figure: [3, (c) => `STOP: smoke does not fit: $${money(c.ledger)} + $${money(c.projection)} above $${money(c.approved)}`] },
  pilot: {
    figure: [3, (c) => `STOP: pilot does not fit: $${money(c.ledger)} + $${money(c.projection)} above $${money(c.approved)}`],
    cap: [4, (c) => `FOUNDER: the pilot projects $${money(c.capSpend + c.projection)} at r = ${AT_R}, above its $${c.cap} budget: go on or stop`],
  },
  'whole-run': {
    figure: [4, (c) => `FOUNDER: the whole run needs $${money(c.ledger + c.margin * c.projection)}; approved $${money(c.approved)}`],
    r: [4, (c) => `FOUNDER: ${c.hot.map(([arm, r]) => `${arm} has r ${r}`).join(', ')} on the pilot, ${R_FLAG} or more: on the pilot tasks the cost per task of each is 0.95 of Opus's or more before any saving; go on or stop`],
  },
  'batch-1': { figure: [3, (c) => `STOP: batch 1 needs $${money(c.ledger + c.margin * c.projection)}; approved $${money(c.approved)}`] },
  'batch-2': { figure: [5, (c) => `STOP: batch 2 needs $${money(c.ledger + c.margin * c.projection)}; approved $${money(c.approved)}; no claim unless the founder raises the figure`] },
};

function checkNotStarted(units, seal, scope) {
  for (const unit of units) if (fs.existsSync(path.join(unit, 'run'))) throw new Error(`admit: ${unit} exists; ${scope} has started`);
  if (seal !== null && fs.existsSync(seal)) throw new Error(`admit: ${seal} exists; ${scope} has started`);
}

/** The mark a driver script reads before it starts a batch: written whole, after the entry that admits it. */
function writeMark(file, entry) {
  writeFileAtomic(file, `${JSON.stringify({ step: entry.step, attempt: entry.attempt, at: entry.at })}\n`);
}

function admit(args, cwd, now) {
  const step = need(args, '--step');
  if (!STEPS.has(step)) throw usage(`--step ${step} is not one of ${[...STEPS].join(', ')}`);
  const [attempt, approved, ledger] = [countFlag(args, '--attempt'), usdFlag(args, '--approved'), usdFlag(args, '--ledger-total')];
  const [log, pinsFile] = [filePath(args, '--log', cwd), filePath(args, '--pins', cwd)];
  const [units, seal] = [listFlag(args, '--units').map((u) => path.resolve(cwd, u)), step === 'seeds' ? need(args, '--seal') : optional(args, '--seal')];
  const mark = ['batch-1', 'batch-2', 'seeds'].includes(step) ? filePath(args, '--mark', cwd) : null;
  const sealFile = seal === null ? null : path.resolve(cwd, seal);
  checkNotStarted(units, sealFile, SCOPES[step]);
  const entries = readLog(log);
  const named = yesGos(entries, 'figure').some((e) => e.figure >= approved);
  if (approved > APPROVED_FIGURE && !named) throw new Error(`--approved ${need(args, '--approved')} is above $${APPROVED_FIGURE.toLocaleString('en-US')}.00 and no founder go names it`);

  const ctx = { entries, attempt, ledger, approved };
  const plan = step === 'seeds' ? raisePlan(args, cwd, ctx) : PLANNERS[step](args, cwd, ctx);
  const check = { ledger, projection: plan.projection, margin: plan.margin, figure: plan.figure ? approved : null, cap: plan.cap, capSpend: plan.capSpend };
  let reason = refusalOf(check);
  if (reason === null && step === 'whole-run' && plan.hot.length > 0) reason = 'r';
  const sealedSeeds = step === 'seeds';
  const admitted = sealedSeeds ? plan.maxSeed > BASE_SEEDS || plan.count <= BASE_SEEDS : reason === null;
  if (sealedSeeds) reason = plan.maxSeed < plan.count ? 'cap' : null;
  const entry = {
    kind: 'admit', step, attempt, units: units.map((u) => path.basename(u)), pinsSha256: readPins(pinsFile).sha256, approved, ledgerBefore: ledger, projection: plan.projection,
    ownProjection: plan.ownProjection ?? plan.projection, scale: plan.scale, margin: plan.margin, cap: plan.cap, capSpend: plan.cap === null ? null : plan.capSpend, admitted, reason, maxSeed: plan.maxSeed ?? null, at: now().toISOString(),
  };
  appendJsonLine(log, entry);
  const lines = plan.lines ?? [];
  if (sealedSeeds) {
    // The seal marks the raise as started, so it goes last: a kill between the writes leaves no seal, and the retry runs a fresh check.
    writeMark(mark, entry);
    writeFileAtomic(sealFile, `${JSON.stringify({ maxSeed: plan.maxSeed, count: plan.count })}\n`);
    return reason === null ? answer(0, `max-seed ${plan.count}`) : answer(6, '', `CAP: max-seed ${plan.maxSeed} of ${plan.count}`);
  }
  if (reason !== null) {
    // A refusal takes back an earlier pass's mark, so a driver script never reads a stale yes.
    if (mark !== null) fs.rmSync(mark, { force: true });
    const [code, line] = REFUSALS[step][reason];
    return answer(code, lines.join('\n'), line({ ...plan, ledger, approved }));
  }
  if (mark !== null) writeMark(mark, entry);
  return answer(0, [...lines, `admit ${step} ok: ledger $${money(ledger)} + ${plan.margin} x $${money(plan.projection)} within $${money(approved)}`].join('\n'));
}

/* --------------------------------------------------------------------------------------- other commands */

function sealScale(args, cwd) {
  const out = filePath(args, '--out', cwd);
  const sealed = readSealed(out);
  if (sealed !== null) return answer(0, `scale ${sealed.scale} (sealed, ${out} is left as it was)`);
  const ledger = usdFlag(args, '--batch1-ledger');
  const [basis, pins, pilot] = [readBasis(filePath(args, '--spend-basis', cwd)), readPins(filePath(args, '--pins', cwd)), readPilot(filePath(args, '--pilot', cwd))];
  const projection = batch1Spend(basis, pins, pilot.rMax);
  if (!(ledger > 0) || !(projection > 0)) throw new Error(`scale: the ledger $${ledger} and batch 1's projection $${projection} must both be above 0`);
  writeFileAtomic(out, `${JSON.stringify({ scale: ledger / projection, ledger, projection }, null, 2)}\n`);
  return answer(0, `scale ${ledger / projection} written to ${out}`);
}

const QUESTIONS = new Set(['whole-run', 'power', 'pilot', 'figure']);

function founderGo(args, cwd, now) {
  const question = need(args, '--question');
  if (!QUESTIONS.has(question)) throw usage(`--question ${question} is not one of ${[...QUESTIONS].join(', ')}`);
  const words = need(args, '--words').trim();
  if (words === '') throw usage('--words must hold the founder\'s words');
  const stop = args.flags.has('--stop');
  // A stop answer names no figure; a go on the figure or the pilot names the one it lifts.
  const needsFigure = !stop && (question === 'figure' || question === 'pilot');
  const figure = (needsFigure || optional(args, '--figure') !== null) ? usdFlag(args, '--figure') : null;
  const attempt = question === 'pilot' ? countFlag(args, '--attempt') : (optional(args, '--attempt') === null ? null : countFlag(args, '--attempt'));
  const log = filePath(args, '--log', cwd);
  const lastWhole = readLog(log).filter((e) => e.kind === 'admit' && e.step === 'whole-run').at(-1);
  if (!stop && question === 'whole-run' && lastWhole?.reason === 'figure') {
    throw new Error('founder-go: the last whole-run check refused on the figure, so log a figure go and run step 2 again at the new --approved');
  }
  const entry = { kind: 'founder-go', question, figure, attempt, stop, words, at: now().toISOString() };
  appendJsonLine(log, entry);
  return answer(0, `founder-go ${question} logged${figure === null ? '' : ` at $${money(figure)}`}${entry.stop ? ' with stop' : ''}`);
}

function report(args, cwd) {
  const [ledgerTotal, approved] = [usdFlag(args, '--ledger-total'), usdFlag(args, '--approved')];
  const admits = readLog(filePath(args, '--log', cwd)).filter((e) => e.kind === 'admit');
  const lines = [];
  admits.forEach((e, i) => {
    if (!e.admitted) return;
    // Batch 2's gate figure adds the raise preview, so growth is read against the batch's own projection.
    const [own, grew] = [e.ownProjection ?? e.projection, (admits[i + 1]?.ledgerBefore ?? ledgerTotal) - e.ledgerBefore];
    const over = grew > own ? `; OVERRUN by $${money(grew - own)}` : '';
    lines.push(`${e.step} attempt ${e.attempt}: projected $${money(own)}, ledger grew $${money(grew)}${over}`);
  });
  const stopped = optional(args, '--stopped');
  if (stopped !== null) lines.push(`stopped: ${stopped} at step ${need(args, '--step')}`);
  const pilotFile = optional(args, '--pilot');
  const pilot = pilotFile !== null && fs.existsSync(path.resolve(cwd, pilotFile)) ? readPilot(path.resolve(cwd, pilotFile), { needR: false }) : null;
  if (pilot === null) lines.push('pilot: none');
  else lines.push(`pilot: $${money(pilot.pilotSpend)} against $${PILOT_BUDGET}`, ...Object.entries(pilot.r).map(([arm, r]) => `r ${arm}: ${r}`));
  lines.push(`effort: ${readPins(filePath(args, '--pins', cwd)).effort}`);
  if (stopped !== null) lines.push(`headline: none, the run stopped at ${stopped}`);
  lines.push(`total: $${money(ledgerTotal)} against approved $${money(approved)}${ledgerTotal > approved ? `; OVER by $${money(ledgerTotal - approved)}` : ''}`);
  return answer(0, lines.join('\n'));
}

/** The lines of `r4-projection.py` that round 3's spend basis feeds, in its words, at 2 decimals. */
function project(args, cwd) {
  const [basis, pins] = [readBasis(filePath(args, '--spend-basis', cwd)), readPins(filePath(args, '--pins', cwd))];
  const keys = listOf(pins, 'batch1Keys');
  const gapByArm = sequenceGap(basis.bySequence, keys);
  const [batch, ceiling] = [sumsOver(basis.bySequence, keys), Object.fromEntries(RULE_ARMS.map((a) => [a, SEED_CAP]))];
  const base = { basisByArm: basis.basisByArm, pilotUsd: PILOT_BUDGET };
  const lines = [1, 1.5, 2].map((r) => `projection at r=${r}, with the pilot: ${money(projectSpend({ ...base, r }))}`);
  lines.push(`ceiling at r=2, with the pilot: ${money(projectSpend({ ...base, r: 2, seedsByArm: ceiling }))}`);
  for (const r of [1, 2]) lines.push(`batch 1 at r=${r}, no pilot: ${money(projectSpend({ basisByArm: batch, r }))}`);
  for (const arm of Object.keys(gapByArm).sort()) lines.push(`q145 gap, ${arm}: ${money(gapByArm[arm])}`);
  for (const r of [1, 2]) {
    const need = [3, 5].map((seeds) => money(PILOT_BUDGET + GATE_MARGIN * wholeRun({ basisByArm: basis.basisByArm, gapByArm, r, seeds })));
    lines.push(`figure the whole-run check needs at r=${r}, 3 and 5 seeds: ${need.join(', ')}`);
  }
  return answer(0, lines.join('\n'));
}

const RUNNERS = { admit, scale: sealScale, 'founder-go': founderGo, report, project };

/** The whole CLI as a function of argv, cwd and a clock, so tests drive it without a child process. */
export function runCli(argv, cwd = process.cwd(), now = () => new Date()) {
  try {
    const args = parseArgs(argv);
    return RUNNERS[args.command](args, cwd, now);
  } catch (e) {
    return answer(1, '', e.message);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
