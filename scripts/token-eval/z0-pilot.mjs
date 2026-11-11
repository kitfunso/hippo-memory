#!/usr/bin/env node
/** Round 4 prereg item 11: the pilot tools. It reads the pilot and effort folders, runs the six pilot checks, prints r and the whole-run figure the admit needs,
 * and writes the pilot.json that z0-budget reads. Exit 0 every check passes, 1 bad input, 3 a check fails. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARM_TABLE, DESIGNS, OPUS_MODEL, allowlistOf, envAllowSet } from './arms.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { Stop, parseFlags, readJson, runCommand, runMain } from './free-cli.mjs';
import { inputHashes, sha256 } from './z0-blind.mjs';
import { GATE_MARGIN, PILOT_BUDGET, R_FLAG, listOf, readBasis, readPins, sequenceGap, wholeRun, wholeRunSeeds } from './z0-budget.mjs';
import { usageRatio } from './z0-cost-solved.mjs';
import { readVoids } from './z0-filters.mjs';
import { checkPrices, costOf } from './z0-prices.mjs';
import { PILOT_SCHEMA, SEED_CAP, cellKey, isBool, isInvalid, isString, locationOf, parsePlan, parseZ0Records, validateCorpus } from './z0-records.mjs';

const USAGE = 'usage: z0-pilot.mjs --runs FILE --plan FILE [--runs FILE --plan FILE ...] --effort-run low:OUT --effort-run high:OUT\n'
  + '       --off-pin FILE [--off-pin FILE ...] --prices FILE --spend-basis FILE --pilot-tasks DIR --pins FILE\n'
  + '       --ledger-total USD --pilot-spend USD --attempt N --tag TAG --out FILE\n'
  + 'exit 0 every check passes, 1 bad input (with this usage), 3 a check fails (PILOT FAIL: <check>)';
const VALUES = ['--prices', '--spend-basis', '--pilot-tasks', '--pins', '--ledger-total', '--pilot-spend', '--attempt', '--tag', '--out'];
const LISTS = ['--runs', '--plan', '--effort-run', '--off-pin'];
const ENTRY = 'scripts/token-eval/z0-pilot.mjs';
const EFFORTS = ['low', 'high'];
const COST_TOLERANCE = 0.001;

// Every arm comes from the design: the base is the second arm of the S1-O1 pair, the r arms are the first arms of that pair and of part (a)'s test.
const ARMS = DESIGNS.r4.arms;
const BASE = DESIGNS.r4.pairs.S1vO1[1];
const R_ARMS = ARMS.filter((a) => a === DESIGNS.r4.pairs.S1vO1[0] || a === DESIGNS.r4.tests.T2a[0]);
const PILOT_ARMS = ARMS.filter((a) => a === BASE || R_ARMS.includes(a));
const EFFORT_ARMS = ARMS.filter((a) => DESIGNS.r4.pairs.S1vO1.includes(a));
// The seed count z0-budget keeps private: the first rule arm's base seeds.
const BASE_SEEDS = ARM_TABLE[DESIGNS.r4.seedRule[0].arms[0]].seeds;

const bad = (message) => new Error(`${message}\n${USAGE}`);
const plain = (v) => v !== undefined && v !== null && v.constructor === Object;
const isName = (v) => isString(v) && v.trim() !== '';
const money = (x) => x.toFixed(2);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const kebab = (key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const folderKey = (cwd, p) => (process.platform === 'win32' ? path.resolve(cwd, p).toLowerCase() : path.resolve(cwd, p));
const modelsOf = (arms) => [...new Set(arms.map((a) => ARM_TABLE[a].model))].sort((x, y) => Number(y === OPUS_MODEL) - Number(x === OPUS_MODEL));
const verdict = (name, reasons, lines = []) => ({ name, reasons, lines });

/* ------------------------------------------------------------------------------------------------ flags */

function effortRuns(values) {
  if (values.length !== EFFORTS.length) throw bad(`--effort-run is given ${values.length} times; it needs exactly ${EFFORTS.length}, one for each of ${EFFORTS.join(' and ')}`);
  const runs = values.map((value) => {
    const colon = value.indexOf(':');
    if (colon < 1 || value.slice(colon + 1).trim() === '') throw bad(`--effort-run ${value} must be <level>:<folder>`);
    return { level: value.slice(0, colon), dir: value.slice(colon + 1) };
  });
  const levels = runs.map((r) => r.level).sort();
  if (levels.join() !== [...EFFORTS].sort().join()) throw bad(`--effort-run levels are ${levels.join(', ')}; they must be ${EFFORTS.join(' and ')}, once each`);
  return EFFORTS.map((level) => runs.find((r) => r.level === level));
}

function numberFlag(args, key, whole) {
  const n = Number(args[key]);
  if (whole ? !Number.isInteger(n) || n < 1 : !Number.isFinite(n) || n < 0) throw bad(`${kebab(key)} ${args[key]} is not ${whole ? 'a whole number from 1' : 'a number of 0 or more'}`);
  return n;
}

function parseArgs(argv, cwd) {
  const args = parseFlags(argv, { values: VALUES, lists: LISTS, required: [...VALUES, ...LISTS] }, USAGE);
  for (const [key, value] of Object.entries(args)) if ([value].flat().some((v) => v.trim() === '')) throw bad(`${kebab(key)} needs a value that is not empty`);
  if (args.runs.length !== args.plan.length) throw bad(`--runs and --plan come in pairs: ${args.runs.length} runs and ${args.plan.length} plans`);
  args.runs.forEach((runs, i) => {
    if (folderKey(cwd, path.dirname(runs)) !== folderKey(cwd, path.dirname(args.plan[i]))) throw bad(`--runs ${runs} and --plan ${args.plan[i]} are not in one folder`);
  });
  return { ...args, efforts: effortRuns(args.effortRun), ledgerUsd: numberFlag(args, 'ledgerTotal', false), spentUsd: numberFlag(args, 'pilotSpend', false), attemptN: numberFlag(args, 'attempt', true) };
}

/* ------------------------------------------------------------------------------------------------ folders */

function checkDone(folder) {
  const have = new Set(folder.records.map(cellKey));
  const missing = folder.cells.find((c) => !have.has(cellKey(c)));
  if (missing !== undefined) throw new Error(`${folder.dir} is not done: cell ${cellKey(missing)} has no record`);
}

/** A pilot folder holds the base and the r arms, an effort folder the effort pair with one record each. */
function checkArms({ role, dir, records, cells }) {
  const want = role === 'pilot' ? PILOT_ARMS : EFFORT_ARMS;
  for (const x of [...records, ...cells]) if (!ARMS.includes(x.arm)) throw new Error(`${locationOf(x)}: arm ${x.arm} is not an arm of the round 4 design`);
  for (const [what, items] of [['records', records], ['plan cells', cells]]) {
    const held = ARMS.filter((a) => items.some((x) => x.arm === a));
    if (held.join() !== want.join()) throw new Error(`${dir}: its ${what} hold arms ${held.join(', ') || 'none'}; a ${role} folder holds exactly ${want.join(', ')}`);
  }
  if (role === 'effort' && records.length !== want.length) throw new Error(`${dir}: an effort folder holds one record per arm (${want.join(', ')}), not ${records.length} records`);
}

/** A session ran when the record carries the runner's own `surfaceRestored`; one with neither that nor an invalid reason is not a record the runner wrote. */
function checkEvidence(records) {
  for (const r of records) {
    const where = locationOf(r);
    if (!Array.isArray(r.envKeys) || !r.envKeys.every(isString)) throw new Error(`${where}: a ${r.arm} record needs envKeys, a list of names`);
    if (!isBool(r.surfaceRestored)) {
      if ((r.invalid ?? null) === null) throw new Error(`${where}: a ${r.arm} record has no surfaceRestored and no invalid reason`);
      continue;
    }
    if (!plain(r.hookCancels)) throw new Error(`${where}: a ${r.arm} record needs a hookCancels object`);
    for (const [event, n] of Object.entries(r.hookCancels)) {
      if (!(Number.isInteger(n) && n >= 0)) throw new Error(`${where}: hookCancels.${event} must be a whole number of 0 or more`);
    }
  }
}

function loadFolder(role, level, runs, plan, cwd) {
  const [runsFile, planFile] = [path.resolve(cwd, runs), path.resolve(cwd, plan)];
  const { records } = parseZ0Records(fs.readFileSync(runsFile, 'utf8'), runs);
  const cells = parsePlan(fs.readFileSync(planFile, 'utf8'), plan);
  validateCorpus(records, cells);
  const folder = { role, level, dir: path.dirname(runsFile), runs, runsFile, records, cells, sha: sha256(runsFile) };
  checkDone(folder);
  checkArms(folder);
  checkEvidence(records);
  return folder;
}

/* ------------------------------------------------------------------------------------------------ off-pin files */

function loadOffPin(label, cwd, runHashes) {
  const voids = readVoids(label, { cwd, runHashes });
  const { runs, pins } = readJson(path.resolve(cwd, label));
  if (!plain(pins) || !isName(pins.file) || !isName(pins.sha256)) throw new Error(`${label}: pins must be { file, sha256 }`);
  const pinsFile = path.resolve(cwd, pins.file);
  if (!fs.existsSync(pinsFile)) throw new Error(`${label}: its pins file ${pins.file} cannot be read`);
  if (sha256(pinsFile) !== pins.sha256) throw new Error(`${label}: pins.sha256 is not the sha256 of ${pins.file}`);
  return { label, voids, runs: runs.map((r) => r.sha256), pinsFile, pinsSha: pins.sha256 };
}

/** Each runs file is named by exactly one off-pin file, so a folder with no off-pin file is never read as 0 voids; the pins it names must be the folder's. */
function bindOffPins(folders, offPins, pinsSha) {
  for (const f of folders) {
    const named = offPins.filter((o) => o.runs.includes(f.sha));
    if (named.length !== 1) throw new Error(`${f.runs}: ${named.length} off-pin files name this runs file; exactly one must, or its voids would read as 0`);
    f.offPin = named[0];
    if (f.role === 'pilot' && f.offPin.pinsSha !== pinsSha) throw new Error(`${f.offPin.label}: its pins sha256 ${f.offPin.pinsSha} is not the --pins file's ${pinsSha}`);
    if (f.role === 'effort') f.boundEffort = readPins(f.offPin.pinsFile).effort;
  }
}

/* ------------------------------------------------------------------------------------------------ pilot tasks */

function venvCheckOf(file, spec) {
  const v = spec.venvCheck;
  if (!plain(v)) throw new Error(`${file}: venvCheck must be an object`);
  for (const f of ['sequence', 'first', 'second', 'package', 'version']) if (!isName(v[f])) throw new Error(`${file}: venvCheck.${f} must be a non-empty string`);
  const sequence = Array.isArray(spec.sequences) ? spec.sequences.find((s) => plain(s) && s.id === v.sequence) : undefined;
  if (sequence === undefined) throw new Error(`${file}: venvCheck.sequence ${v.sequence} is not a sequence of this file`);
  const ids = (Array.isArray(sequence.tasks) ? sequence.tasks : []).map((t) => t?.id);
  for (const f of ['first', 'second']) if (!ids.includes(v[f])) throw new Error(`${file}: venvCheck.${f} ${v[f]} is not a task of ${v.sequence}`);
  if (ids.indexOf(v.first) >= ids.indexOf(v.second)) throw new Error(`${file}: venvCheck.first ${v.first} must come before venvCheck.second ${v.second} in ${v.sequence}`);
  return { sequence: v.sequence, first: v.first, second: v.second, package: v.package, version: v.version };
}

/** The one tasks file of the pilot-tasks folder that holds a venvCheck, and the one pilot folder whose plan runs its sequence. */
function loadVenvCheck(dir, pilots, cwd) {
  const root = path.resolve(cwd, dir);
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name, 'tasks-run.json');
    const spec = readJson(file);
    if (!plain(spec)) throw new Error(`${file}: must be a JSON object`);
    if (spec.venvCheck !== undefined) found.push({ file, spec });
  }
  if (found.length !== 1) throw new Error(`${dir}: ${found.length} tasks files hold a venvCheck; exactly one must`);
  const check = venvCheckOf(found[0].file, found[0].spec);
  const holders = pilots.filter((f) => f.cells.some((c) => c.sequence === check.sequence));
  if (holders.length !== 1) throw new Error(`${holders.length === 0 ? 'no pilot plan holds' : `${holders.length} pilot plans hold`} cells of venvCheck.sequence ${check.sequence}; exactly one must`);
  return { check, folder: holders[0] };
}

/* ------------------------------------------------------------------------------------------------ inputs */

function loadPlainJson(label, cwd) {
  const body = readJson(path.resolve(cwd, label));
  if (!plain(body)) throw new Error(`${label} must be a JSON object`);
  return body;
}

/** The spend basis and pins, read as z0-budget reads them, with the gap and seed count its whole-run lines need; one projection at r = 1 proves they price. */
function loadBudget(args, cwd) {
  const [basisFile, pinsFile] = [path.resolve(cwd, args.spendBasis), path.resolve(cwd, args.pins)];
  const basis = readBasis(basisFile);
  if (!plain(basis.basisByArm) || !plain(basis.bySequence)) throw new Error(`${args.spendBasis}: basisByArm and bySequence must be objects`);
  loadPlainJson(args.pins, cwd);
  const pins = readPins(pinsFile);
  const [seeds, gapByArm] = [wholeRunSeeds(pins), sequenceGap(basis.bySequence, listOf(pins, 'batch1Keys'))];
  wholeRun({ basisByArm: basis.basisByArm, gapByArm, r: 1, seeds });
  return { basis, pins, seeds, gapByArm };
}

function loadInputs(args, cwd) {
  const pilots = args.runs.map((runs, i) => loadFolder('pilot', null, runs, args.plan[i], cwd));
  const efforts = args.efforts.map(({ level, dir }) => loadFolder('effort', level, path.join(dir, 'runs.jsonl'), path.join(dir, 'plan.json'), cwd));
  const folders = [...pilots, ...efforts];
  const seen = new Set();
  for (const f of folders) {
    if (seen.has(folderKey(cwd, f.runs))) throw new Error(`${f.runs} is given twice`);
    seen.add(folderKey(cwd, f.runs));
  }
  const prices = loadPlainJson(args.prices, cwd);
  checkPrices(prices, args.prices, DESIGNS.r4);
  const budget = loadBudget(args, cwd);
  const offPins = args.offPin.map((label) => loadOffPin(label, cwd, folders.map((f) => f.sha)));
  bindOffPins(folders, offPins, budget.pins.sha256);
  return { pilots, efforts, folders, offPins, prices, ...budget, venv: loadVenvCheck(args.pilotTasks, pilots, cwd) };
}

/* ------------------------------------------------------------------------------------------------ the checks */

const checkOffPin = ({ offPins }) => verdict('off-pin', offPins.flatMap((o) => o.voids.map((v) => `${v.sequence} seed ${v.seed} ${v.arm} position ${v.position} ${v.reason}`)));

const outputTokens = (records) => (records.some((r) => r.usage === null) ? null : sum(records.map((r) => r.usage.firstSession.outputTokens + r.usage.extra.outputTokens)));

function checkEffort({ efforts }) {
  const [reasons, lines] = [[], []];
  for (const f of efforts) {
    if (f.boundEffort !== f.level) reasons.push(`the ${f.level} folder's off-pin file names a pins file at effort ${f.boundEffort}, not ${f.level}`);
  }
  for (const model of modelsOf(EFFORT_ARMS)) {
    const [low, high] = efforts.map((f) => ({ level: f.level, tokens: outputTokens(f.records.filter((r) => ARM_TABLE[r.arm].model === model)) }));
    for (const { level, tokens } of [low, high]) if (tokens === null) reasons.push(`${model} at ${level} has no usage`);
    if (low.tokens === null || high.tokens === null) continue;
    lines.push(`effort ${model}: low ${low.tokens}, high ${high.tokens}`);
    if (!(low.tokens < high.tokens)) reasons.push(`${model}: output tokens at low (${low.tokens}) are not below high (${high.tokens})`);
  }
  return verdict('effort', reasons, lines);
}

/** The names of a package list: each entry's text before any `==`, lowercased. */
const namesIn = (value) => value.split(/[,\s]+/).filter(Boolean).map((entry) => entry.split('==')[0].toLowerCase());

/** The `key=value` lines of one venv file, split at the first `=`; a line with no key and a key given twice are reasons. */
function parseVenv(file, reasons) {
  const map = new Map();
  for (const [i, raw] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    const eq = line.indexOf('=');
    if (line.trim() === '') continue;
    if (eq < 1) reasons.push(`${file} line ${i + 1} is not key=value`);
    else if (map.has(line.slice(0, eq))) reasons.push(`${file} line ${i + 1} repeats ${line.slice(0, eq)}`);
    else map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

/** One task's venv file against the plant: the first task installs the package and imports it, the second has neither, and each prefix is its own venv. */
function taskReasons({ dir, v, arm, seed, task, position }, isSecond, venvFiles) {
  const file = path.join(dir, 'raw', v.sequence, arm, `seed${seed}`, `${task}.venv.txt`);
  const who = `${v.sequence} seed ${seed} ${arm} ${task}`;
  if (!fs.existsSync(file)) return [`${who}: ${file} is missing`];
  venvFiles.push(file);
  const reasons = [];
  const map = parseVenv(file, reasons);
  const [now, end] = ['packages', 'packages_end'].map((key) => (map.has(key) ? namesIn(map.get(key)) : null));
  const [pkg, imported] = [v.package.toLowerCase(), map.get(`import_${v.package}`)];
  if (!isSecond) {
    if (now === null || !now.includes(pkg)) reasons.push(`${who}: planted package not installed`);
    if (imported !== 'ok') reasons.push(`${who}: planted package does not import`);
  } else {
    if (now === null) reasons.push(`${file} has no packages`);
    if (end === null) reasons.push(`${file} has no packages_end`);
    if ((now ?? []).includes(pkg) || (end ?? []).includes(pkg)) reasons.push(`${who}: planted package in the second task`);
    if (imported !== 'fail') reasons.push(`${who}: planted package imports in the second task`);
  }
  const want = path.join(dir, 'runs', v.sequence, arm, `seed${seed}`, 'venv', String(position));
  if (!map.has('prefix')) reasons.push(`${file} has no prefix`);
  else if (folderKey('.', map.get('prefix')) !== folderKey('.', want)) reasons.push(`${who}: prefix ${map.get('prefix')} is not its own venv ${want}`);
  return reasons;
}

function checkVenv({ venv: { check: v, folder } }, venvFiles) {
  const cells = folder.cells.filter((c) => c.sequence === v.sequence);
  const reasons = [];
  for (const arm of ARMS) {
    for (const seed of [...new Set(cells.filter((c) => c.arm === arm).map((c) => c.seed))].sort((x, y) => x - y)) {
      const tasks = [v.first, v.second];
      const positions = tasks.map((task) => cells.find((c) => c.arm === arm && c.seed === seed && c.taskId === task)?.position);
      const who = `${v.sequence} seed ${seed} ${arm}`;
      if (positions.includes(undefined)) {
        reasons.push(`${who}: the plan has no cell for ${tasks.filter((_, i) => positions[i] === undefined).join(' and ')}`);
        continue;
      }
      if (positions[0] >= positions[1]) reasons.push(`${who}: the second task ran before the first`);
      tasks.forEach((task, i) => reasons.push(...taskReasons({ dir: folder.dir, v, arm, seed, task, position: positions[i] }, i === 1, venvFiles)));
    }
  }
  return verdict('venv', reasons);
}

function checkEnvKeys({ folders }) {
  const allowed = envAllowSet(allowlistOf(DESIGNS.r4));
  const [reasons, lines] = [[], []];
  for (const arm of ARMS) {
    const mine = folders.flatMap((f) => f.records).filter((r) => r.arm === arm);
    if (mine.length === 0) continue;
    const outside = [...new Set(mine.flatMap((r) => r.envKeys.map((k) => k.toUpperCase())).filter((n) => !allowed.has(n)))].sort();
    lines.push(`env-keys ${arm}: ${mine.length} records, outside ${outside.length === 0 ? 'none' : outside.join(', ')}`);
    if (outside.length > 0) reasons.push(`${arm} has ${outside.join(', ')} outside the allowlist`);
  }
  return verdict('env-keys', reasons, lines);
}

/** Each record's costUsd against its usage priced at its model's row, outside at more than 0.1% of the priced figure. */
function checkCost({ folders, prices }, pricesFile) {
  const records = folders.flatMap((f) => f.records);
  const withCost = records.filter((r) => Number.isFinite(r.costUsd));
  const outside = [];
  for (const r of withCost) {
    if (r.usage === null) {
      outside.push(`${locationOf(r)} has a costUsd and no usage`);
      continue;
    }
    const priced = costOf(r, prices, { design: DESIGNS.r4, rowModel: r.model, file: pricesFile });
    if (Math.abs(r.costUsd - priced) > COST_TOLERANCE * priced) outside.push(`${locationOf(r)} costUsd ${r.costUsd}, priced ${priced}`);
  }
  const lines = [`cost-usd: ${withCost.length} records, ${outside.length} outside 0.1%, ${records.length - withCost.length} with no costUsd`, ...outside];
  const reasons = withCost.length === 0 ? ['no record has a costUsd'] : outside.length === 0 ? [] : [`${outside.length} of ${withCost.length} records are outside 0.1%`];
  return verdict('cost-usd', reasons, lines);
}

/** r per arm on the pilot folders' records; an r that cannot be read is null and fails the check. */
function checkR({ pilots, prices }) {
  const records = pilots.flatMap((f) => f.records);
  const r = Object.fromEntries(R_ARMS.map((arm) => {
    const ratio = usageRatio(records, arm, BASE, prices);
    return [arm, Number.isFinite(ratio) && ratio > 0 ? ratio : null];
  }));
  const reasons = R_ARMS.filter((arm) => r[arm] === null).map((arm) => `no task both ${arm} and ${BASE} ran with usage`);
  return { ...verdict('r', reasons), r };
}

/** The r lines, the larger r with its arm, and the flag at R_FLAG or more; an r that is null gives no larger r and no flag.
 * @param {Record<string, number | null>} rByArm @returns {{rMax: number | null, rArm: string | null, flag19: boolean, lines: string[]}} */
export function rSummary(rByArm) {
  const arms = Object.keys(rByArm).sort((a, b) => ARMS.indexOf(a) - ARMS.indexOf(b));
  const unknown = arms.find((a) => !ARMS.includes(a));
  if (unknown !== undefined) throw new Error(`rSummary: ${unknown} is not an arm of the round 4 design`);
  const rOf = (a) => (Number.isFinite(rByArm[a]) && rByArm[a] > 0 ? rByArm[a] : null);
  const lines = arms.map((a) => `r ${a}: ${rOf(a)}`);
  if (arms.length === 0 || arms.some((a) => rOf(a) === null)) return { rMax: null, rArm: null, flag19: false, lines };
  const rArm = arms.reduce((best, a) => (rOf(a) > rOf(best) ? a : best));
  const hot = arms.filter((a) => rOf(a) >= R_FLAG);
  lines.push(`r ${rOf(rArm)} from ${rArm}`, ...hot.map((a) => `on the pilot tasks ${a}'s cost per task is ${R_FLAG / 2} of Opus's or more before any saving`));
  return { rMax: rOf(rArm), rArm, flag19: hot.length > 0, lines };
}

/* ------------------------------------------------------------------------------------------------ the report */

function cancelLines(folders) {
  const records = folders.flatMap((f) => f.records);
  return ARMS.filter((arm) => records.some((r) => r.arm === arm)).map((arm) => {
    const sessions = records.filter((r) => r.arm === arm && isBool(r.surfaceRestored));
    return `hook-cancels ${arm} ${sum(sessions.flatMap((r) => Object.values(r.hookCancels)))} in ${sessions.length} sessions`;
  });
}

function cellLines(pilots) {
  const records = pilots.flatMap((f) => f.records);
  return modelsOf(PILOT_ARMS).map((model) => {
    const mine = records.filter((r) => ARM_TABLE[r.arm].model === model);
    return `cells ${model}: ${mine.length}, invalid ${mine.filter(isInvalid).length}, timeout ${mine.filter((r) => r.timedOut === true).length}`;
  });
}

const spendLine = (spent) => `pilot spend $${money(spent)} of its $${PILOT_BUDGET} budget${spent > PILOT_BUDGET ? `; above its $${PILOT_BUDGET} budget` : ''}`;

/** The projections z0-budget's whole-run admit prints, in its words, and the figure the whole-run check needs. */
function projectionLines(rMax, { basis, gapByArm, seeds }, ledgerUsd) {
  if (rMax === null) return ['projection: no r'];
  const at = (n) => wholeRun({ basisByArm: basis.basisByArm, gapByArm, r: rMax, seeds: n });
  const lines = [BASE_SEEDS, seeds, SEED_CAP].map((n) => `projection at r ${rMax}, ${n} seeds: $${money(at(n))}`);
  return [...lines, `whole-run at r ${rMax}, ${seeds} seeds: $${money(at(seeds))}; the check needs $${money(ledgerUsd + GATE_MARGIN * at(seeds))}`];
}

function execute(argv, cwd) {
  const args = parseArgs(argv, cwd);
  const inputs = loadInputs(args, cwd);
  const venvFiles = [];
  const rResult = checkR(inputs);
  const results = [checkOffPin(inputs), checkEffort(inputs), checkVenv(inputs, venvFiles), checkEnvKeys(inputs), checkCost(inputs, args.prices), rResult];
  const lines = results.flatMap((c) => [...c.lines, c.reasons.length === 0 ? `check ${c.name} pass` : `check ${c.name} fail: ${c.reasons.join('; ')}`]);
  const summary = rSummary(rResult.r);
  lines.push(...cancelLines(inputs.folders), ...summary.lines, ...cellLines(inputs.pilots), spendLine(args.spentUsd), ...projectionLines(summary.rMax, inputs, args.ledgerUsd));
  const extra = [...args.efforts.flatMap((e) => [['effort-runs', path.join(e.dir, 'runs.jsonl')], ['effort-runs', path.join(e.dir, 'plan.json')]]),
    ['pilot-tasks', args.pilotTasks], ['pins', args.pins], ['spend-basis', args.spendBasis], ...venvFiles.map((f) => ['venv', f])];
  const hashes = inputHashes({ runs: args.runs, plan: args.plan, prices: args.prices, offPin: args.offPin }, cwd, { entry: ENTRY, extra });
  const checks = Object.fromEntries(results.map((c) => [c.name, c.reasons.length === 0 ? 'pass' : 'fail']));
  const body = { schema: PILOT_SCHEMA, attempt: args.attemptN, tag: args.tag, r: rResult.r, rArm: summary.rArm, rMax: summary.rMax, flag19: summary.flag19, ledgerTotal: args.ledgerUsd, pilotSpend: args.spentUsd, checks, hashes };
  writeFileAtomic(path.resolve(cwd, args.out), `${JSON.stringify(body, null, 2)}\n`);
  const [stdout, failed] = [`${lines.join('\n')}\n`, results.filter((c) => c.reasons.length > 0)];
  if (failed.length > 0) throw new Stop(failed.map((c) => `PILOT FAIL: ${c.name}`).join('\n'), stdout);
  return stdout;
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  return runCommand(() => {
    try {
      return execute(argv, cwd);
    } catch (e) {
      if (e instanceof Stop || e.message.includes(USAGE)) throw e;
      throw new Error(`${e.message}\n${USAGE}`, { cause: e });
    }
  });
}

runMain(import.meta.url, runCli);
