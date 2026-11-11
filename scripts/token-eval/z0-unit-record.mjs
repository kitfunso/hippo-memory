#!/usr/bin/env node
/** Round 4 Failure and Record models for bash: whether a unit or a G5 call is done by the records its own process wrote, and the JSON the batch script reads (keys, arms, max seed, toolchain, empty labels).
 * Exit 0 with its lines, 1 on bad input with the usage. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARM_TABLE, DESIGNS } from './arms.mjs';
import { readSealed } from './atomic-write.mjs';
import { linesOf, parseOrNull, readJson, runCommand, runMain } from './free-cli.mjs';
import { keysOf } from './z0-read-set.mjs';
import { cellKey, parsePlan } from './z0-records.mjs';

const USAGE = [
  'usage: z0-unit-record.mjs unit FOLDER',
  '       z0-unit-record.mjs call FOLDER regrade|reader-draw|stored-draw|reader-score|stored-score|grading',
  '       z0-unit-record.mjs sealed FOLDER regrade|reader-draw|stored-draw|reader-score|stored-score|grading',
  '       z0-unit-record.mjs keys ROOT 1|2|raise',
  '       z0-unit-record.mjs arms first 1|2|raise',
  '       z0-unit-record.mjs arms rerun FOLDER SEED',
  '       z0-unit-record.mjs max-seed ROOT',
  '       z0-unit-record.mjs seeds LEAKS_FILE',
  '       z0-unit-record.mjs labels FILE',
  '       z0-unit-record.mjs toolchain KEY [REPOS_FILE]',
].join('\n');
const DEFAULT_REPOS = 'C:/eval-authors/r3-repos.json';
const ARMS = DESIGNS.r4.arms;
const KEY_FIELDS = { 1: ['batch1Keys'], 2: ['batch2Keys'], raise: ['batch1Keys', 'batch2Keys'] };
const num = '(\\d+)';
// Each call's summary line, round 1 only: z0-regrade.mjs:90, reader-sample.mjs:163, :197, :209, :222, stored-sample.mjs:58, :80, :92, :106 and z0-regrade.mjs:144.
const SUMMARIES = {
  regrade: new RegExp(`^(?:repro|postfix): regraded ${num} cells \\(${num} with errors\\), skipped ${num} done ones(?:; wrote ${num})?$`),
  'reader-draw': /^reader round 1: (?:drew|already drawn,) /,
  'stored-draw': /^stored sample: (?:drew|already drawn,) /,
  'reader-score': new RegExp(`^reader round 1: ${num} of ${num} labels disagree$`),
  'stored-score': new RegExp(`^stored sample: ${num} of ${num} labels agree with the key-phrase judgement$`),
  grading: new RegExp(`^wrote .+: ${num} flipped lessons, ${num} acceptance flips$`),
};

// The sealed files each G5 call leaves under `<folder>/run/g5/sealed`: reader-sample.mjs:15-16, stored-sample.mjs:15-16.
const SEALED = {
  regrade: [],
  'reader-draw': ['reader-r1.key.json'],
  'stored-draw': ['stored.key.json'],
  'reader-score': ['reader-r1.key.json', 'reader-r1.score.json'],
  'stored-score': ['stored.key.json', 'stored.score.json'],
  grading: ['reader-r1.key.json', 'reader-r1.score.json', 'stored.key.json', 'stored.score.json'],
};

const bad = (message) => new Error(`${message}\n${USAGE}`);

/** Lowercase, `\` as `/`, a leading `/<letter>/` as `<letter>:/`, no trailing slash: the form the scan prints. */
export function pathForm(p) {
  const t = p.toLowerCase().replace(/\\/g, '/').replace(/^\/([a-z])\//, '$1:/');
  return t.length > 3 ? t.replace(/\/+$/, '') : t;
}

const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n') : []);

/** The record lines of a runs file, a torn last line (no final line feed, does not parse) skipped; any other bad line stops, naming the file and line. */
function recordsOf(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const records = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const r = parseOrNull(line);
    if (r !== null && r.constructor === Object) return void records.push(r);
    if (i === lines.length - 1) return;
    throw new Error(`${file} line ${i + 1}: not a JSON record`);
  });
  return records;
}

/** Why the folder's records are not complete, or null when its plan's every cell has one (the Record model's complete records). */
function incompleteWhy(run) {
  if (fs.existsSync(path.join(run, 'ABANDONED'))) return 'abandoned';
  const planFile = path.join(run, 'plan.json');
  let plan;
  try {
    plan = parsePlan(fs.readFileSync(planFile, 'utf8'), planFile);
  } catch {
    return 'no-plan';
  }
  const have = new Set(recordsOf(path.join(run, 'runs.jsonl')).map(cellKey));
  const missing = plan.filter((c) => !have.has(cellKey(c))).length;
  return missing === 0 ? null : `missing ${missing} of ${plan.length} cells`;
}

/** @returns {string} `record done <folder> records-line|all-records`, or `record none <folder> <why>` */
export function unitRecord(folder) {
  const want = pathForm(`${folder}/run/runs.jsonl`);
  if (readLines(path.join(folder, 'run.log')).some((l) => l.startsWith('Records: ') && pathForm(l.slice('Records: '.length)) === want)) return `record done ${folder} records-line`;
  const why = incompleteWhy(path.join(folder, 'run'));
  return why === null ? `record done ${folder} all-records` : `record none ${folder} ${why}`;
}

/** @returns {string} `record done <folder> <call>`, or `record none <folder> error-rows <e>|no-log|no-summary` */
export function callRecord(folder, call) {
  const last = readLines(path.join(folder, `g5-${call}.log`)).filter((l) => l.trim() !== '').at(-1);
  if (last === undefined) return `record none ${folder} no-log`;
  const m = SUMMARIES[call].exec(last);
  if (m === null) return `record none ${folder} no-summary`;
  if (call === 'regrade' && Number(m[2]) > 0) return `record none ${folder} error-rows ${m[2]}`;
  return `record done ${folder} ${call}`;
}

/** @returns {string} `sealed ok <folder> <call>`; a sealed file of the call that is absent or does not parse throws, naming it (Record model: sealed files are never rebuilt). */
export function sealedLine(folder, call) {
  for (const name of SEALED[call]) {
    const file = path.join(folder, 'run', 'g5', 'sealed', name);
    if (readSealed(file) === null) throw new Error(`${file}: sealed file is missing; call ${call} seals it`);
  }
  return `sealed ok ${folder} ${call}\n`;
}

function keysLines(root, which) {
  const file = path.join(root, 'pins-r4.json');
  const pins = readJson(file);
  return KEY_FIELDS[which].flatMap((field) => keysOf(pins, field, file)).map((k) => `${k}\n`).join('');
}

function armsLine(args) {
  if (args[0] === 'first' && args.length === 2 && Object.hasOwn(KEY_FIELDS, args[1])) return `${(args[1] === 'raise' ? ARMS.filter((a) => ARM_TABLE[a].seedRule) : ARMS).join(',')}\n`;
  if (args[0] !== 'rerun' || args.length !== 3 || !/^\d+$/.test(args[2])) throw bad('arms takes first 1|2|raise or rerun FOLDER SEED');
  const planFile = path.join(args[1], 'run', 'plan.json');
  const planned = new Set(parsePlan(fs.readFileSync(planFile, 'utf8'), planFile).filter((c) => c.seed === Number(args[2])).map((c) => c.arm));
  if (planned.size === 0) throw new Error(`${planFile}: plans no cell at seed ${args[2]}`);
  return `${ARMS.filter((a) => planned.has(a)).join(',')}\n`;
}

function maxSeedLine(root) {
  const file = path.join(root, 'raise', 'max-seed.json');
  const sealed = readSealed(file);
  if (sealed === null) throw new Error(`${file}: no such file`);
  if (!Number.isInteger(sealed.maxSeed) || sealed.maxSeed < 1) throw new Error(`${file}: maxSeed must be a positive integer`);
  return `max-seed ${sealed.maxSeed}\n`;
}

/** The distinct seeds a leak list names, ascending: one reruns unit each (every key holds one sequence). */
function seedsLines(file) {
  const { leaks } = readJson(file);
  if (!Array.isArray(leaks) || !leaks.every((l) => Number.isInteger(l?.seed))) throw new Error(`${file}: leaks must be a list of { sequence, seed }`);
  return [...new Set(leaks.map((l) => l.seed))].sort((a, b) => a - b).map((s) => `${s}\n`).join('');
}

function labelsLine(file) {
  if (!fs.existsSync(file)) throw new Error(`${file}: no such file`);
  const rows = linesOf(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r/g, '')).filter((l) => !l.startsWith('#'));
  const empty = rows.filter((l) => (l.split('\t')[1] ?? '').trim() === '').length;
  return empty === 0 ? `labels filled ${file}\n` : `labels empty ${empty} ${file}\n`;
}

function toolchainLine(key, file) {
  const entry = readJson(file)[key];
  if (!/^[A-Za-z0-9-]+$/.test(entry?.toolchain ?? '')) throw new Error(`${file}: ${key} has no toolchain name`);
  return `${entry.toolchain}\n`;
}

const COMMANDS = {
  unit: (a) => (a.length === 1 ? `${unitRecord(a[0])}\n` : null),
  call: (a) => (a.length === 2 && Object.hasOwn(SUMMARIES, a[1]) ? `${callRecord(a[0], a[1])}\n` : null),
  sealed: (a) => (a.length === 2 && Object.hasOwn(SEALED, a[1]) ? sealedLine(a[0], a[1]) : null),
  keys: (a) => (a.length === 2 && Object.hasOwn(KEY_FIELDS, a[1]) ? keysLines(a[0], a[1]) : null),
  arms: (a) => armsLine(a),
  'max-seed': (a) => (a.length === 1 ? maxSeedLine(a[0]) : null),
  seeds: (a) => (a.length === 1 ? seedsLines(a[0]) : null),
  labels: (a) => (a.length === 1 ? labelsLine(a[0]) : null),
  toolchain: (a) => (a.length === 1 || a.length === 2 ? toolchainLine(a[0], a[1] ?? DEFAULT_REPOS) : null),
};

/** @param {string[]} argv */
export function runCli(argv) {
  return runCommand(() => {
    const [name, ...rest] = argv;
    if (!Object.hasOwn(COMMANDS, name ?? '') || rest.some((a) => a === '' || a.startsWith('--'))) throw bad(`unknown command or empty argument: ${argv.join(' ')}`);
    const out = COMMANDS[name](rest);
    if (out === null) throw bad(`wrong arguments for ${name}`);
    return out;
  });
}

runMain(import.meta.url, runCli);
