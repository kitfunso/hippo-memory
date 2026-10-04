#!/usr/bin/env node
/** Z0 G5 (prereg 166): regrade every saved check and test, then write the grading file z0-analyze.mjs reads.
 * Usage and readings: benchmarks/token-eval/README.md, "G5 regrade". Exit 0 on success, 1 on bad input or a refusal. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTasks } from './ab-run.mjs';
import { parseZ0Records } from './z0-records.mjs';
import { listGrades, readRows, rowsFile, runRegrade } from './regrade.mjs';
import { drawReader, readerSummary, scoreReader } from './reader-sample.mjs';
import { drawStored, scoreStored, storedSummary } from './stored-sample.mjs';

const USAGE = [
  'usage: z0-regrade.mjs regrade --out DIR --tasks FILE [--runs FILE] [--post-fix] [--cell KEY]...',
  '       z0-regrade.mjs reader --out DIR (--tasks FILE --seed N [--n N] [--round K] | [--round K] --labels FILE)',
  '       z0-regrade.mjs stored --out DIR (--tasks FILE --seed N [--n N] [--runs FILE] | --labels FILE)',
  '       z0-regrade.mjs grading --out DIR [--flip-errors]',
].join('\n');
const MODES = {
  regrade: { values: ['--out', '--tasks', '--runs'], multi: ['--cell'], flags: ['--post-fix'], required: ['--out', '--tasks'] },
  reader: { values: ['--out', '--tasks', '--seed', '--n', '--round', '--labels'], multi: [], flags: [], required: ['--out'] },
  stored: { values: ['--out', '--tasks', '--runs', '--seed', '--n', '--labels'], multi: [], flags: [], required: ['--out'] },
  grading: { values: ['--out'], multi: [], flags: ['--flip-errors'], required: ['--out'] },
};
const camel = (flag) => flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());

/** Mode, then its flags; an unknown or repeated flag is refused, so a typo never silently changes a draw or a pass. */
export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const spec = MODES[mode];
  if (!spec) throw new Error(USAGE);
  const args = { mode };
  for (const f of spec.multi) args[camel(f)] = [];
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (spec.flags.includes(f)) {
      args[camel(f)] = true;
      continue;
    }
    if (!spec.values.includes(f) && !spec.multi.includes(f)) throw new Error(`${mode}: unknown flag ${f}\n${USAGE}`);
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${mode}: ${f} needs a value`);
    if (spec.multi.includes(f)) args[camel(f)].push(v);
    else if (camel(f) in args) throw new Error(`${mode}: ${f} given twice`);
    else args[camel(f)] = v;
  }
  for (const f of spec.required) if (args[camel(f)] === undefined) throw new Error(`${mode} needs ${f}\n${USAGE}`);
  return args;
}

/** One writer at a time under `<out>/g5/`; a leftover lock is never broken automatically, since its regrade may still run. */
export function withLock(out, fn) {
  const lock = path.join(out, 'g5', 'regrade.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    throw new Error(`${lock} exists: another regrade is running, or one was killed; remove the file by hand once none runs`);
  }
  fs.writeSync(fd, `${process.pid}\n`);
  fs.closeSync(fd);
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Keys sorted at every depth, so the same inputs give the same bytes. */
export const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || v === undefined || v.constructor !== Object) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
};

function regradeMode(args, out, cwd, log) {
  const tasksFile = path.resolve(cwd, args.tasks);
  const spec = validateTasks(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), path.dirname(tasksFile));
  const runsFile = args.runs ? path.resolve(cwd, args.runs) : path.join(out, 'runs.jsonl');
  const { records } = parseZ0Records(fs.readFileSync(runsFile, 'utf8'), runsFile);
  const pass = args.postFix ? 'postfix' : 'repro';
  const tally = runRegrade({ out, spec, records, runsFile, pass, cells: args.cell, baseEnv: process.env, log });
  const wrote = tally.regraded ? `; wrote ${tally.regraded}` : '';
  return `${pass}: regraded ${tally.ran} cells (${tally.errors} with errors), skipped ${tally.skipped} done ones${wrote}\n`;
}

/** Flips from the latest row of each cell in each pass run so far; error rows refuse unless --flip-errors drops their lessons. */
function flipsOf(out, entries, flipErrors) {
  const passes = fs.existsSync(rowsFile(out, 'postfix')) ? ['repro', 'postfix'] : ['repro'];
  const flipped = new Set();
  const accepted = new Set();
  const unrepro = { cells: new Set(), lessons: new Set() };
  const extra = new Set();
  const errors = [];
  for (const pass of passes) {
    const rows = readRows(rowsFile(out, pass)).rows;
    for (const e of entries) {
      const row = rows.get(e.key);
      if (!row) throw new Error(`cell ${e.key} has no ${pass} row; run regrade${pass === 'postfix' ? ' --post-fix' : ''} first`);
      for (const k of row.extraEnvKeys ?? []) extra.add(k);
      if (row.status === 'error') {
        errors.push(`${e.key} (${pass}, ${row.error.stage})`);
        unrepro.cells.add(e.key);
        for (const id of [row.lessonId, row.staleLessonId].filter(Boolean)) unrepro.lessons.add(id);
        continue;
      }
      for (const c of row.checks) if (c.flip) flipped.add(c.lessonId);
      if (row.acceptance.flip) accepted.add(e.key);
    }
  }
  if (errors.length && !flipErrors) throw new Error(`${errors.length} cells have error rows: ${errors.slice(0, 5).join(', ')}; re-run regrade, or pass --flip-errors to drop their lessons`);
  for (const id of unrepro.lessons) flipped.add(id);
  for (const k of unrepro.cells) accepted.add(k);
  return { pass: passes.at(-1), flipped, accepted, unrepro, extra };
}

/** The grading file (166): E7's three fields, then `g5` with the regrade's own counts; no field holds an arm (R11). */
export function buildGrading(out, { flipErrors = false } = {}) {
  const entries = listGrades(out);
  if (entries.length === 0) throw new Error(`no grade.json under ${path.join(out, 'grading')}`);
  const f = flipsOf(out, entries, flipErrors);
  const reader = readerSummary(out);
  const g5 = {
    pass: f.pass, cells: entries.length, unreproducible: { cells: f.unrepro.cells.size, lessons: [...f.unrepro.lessons].sort() }, ...reader.g5, extraEnvKeys: [...f.extra].sort(),
  };
  const grading = { flippedLessons: [...f.flipped].sort(), acceptanceFlips: f.accepted.size, readerSample: reader.readerSample, g5 };
  // Present only once scored, so an unscored stored sample leaves E7's file shape unchanged.
  const storedSample = storedSummary(out);
  if (storedSample) grading.storedSample = storedSample;
  return sortKeys(grading);
}

const count = (v, flag, min) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${flag} must be a whole number of at least ${min}, got ${v}`);
  return Number(v);
};

/** A draw needs --tasks and --seed (no default, so the seed is always a recorded choice); scoring takes only --labels. */
function sampleArgs(args, cwd, drawFlags) {
  if (args.labels !== undefined) {
    const extra = drawFlags.filter((f) => args[camel(f)] !== undefined);
    if (extra.length) throw new Error(`${args.mode} --labels scores a drawn sample and takes no ${extra.join(', ')}`);
    return { labels: path.resolve(cwd, args.labels) };
  }
  for (const f of ['--tasks', '--seed']) if (args[camel(f)] === undefined) throw new Error(`${args.mode} needs ${f} to draw, or --labels to score\n${USAGE}`);
  return { tasksFile: path.resolve(cwd, args.tasks), seed: count(args.seed, '--seed', 0), n: count(args.n, '--n', 1) ?? 30 };
}

function readerMode(args, out, cwd) {
  const round = count(args.round, '--round', 1) ?? 1;
  const a = sampleArgs(args, cwd, ['--tasks', '--seed', '--n']);
  return a.labels ? scoreReader(out, round, a.labels) : drawReader(out, { ...a, round });
}

function storedMode(args, out, cwd) {
  const a = sampleArgs(args, cwd, ['--tasks', '--seed', '--n', '--runs']);
  if (a.labels) return scoreStored(out, a.labels);
  return drawStored(out, { ...a, runsFile: args.runs ? path.resolve(cwd, args.runs) : path.join(out, 'runs.jsonl') });
}

function gradingMode(args, out) {
  const grading = buildGrading(out, { flipErrors: args.flipErrors === true });
  const file = path.join(out, 'grading.json');
  fs.writeFileSync(file, `${JSON.stringify(grading, null, 2)}\n`);
  return `wrote ${file}: ${grading.flippedLessons.length} flipped lessons, ${grading.acceptanceFlips} acceptance flips\n`;
}

const RUN = { regrade: regradeMode, reader: readerMode, stored: storedMode, grading: gradingMode };

/** The whole CLI as a function of argv and cwd, so tests drive it without a child process. */
export function runCli(argv, cwd = process.cwd()) {
  const notes = [];
  try {
    const args = parseArgs(argv);
    const given = path.resolve(cwd, args.out);
    if (!fs.existsSync(given)) throw new Error(`--out ${args.out}: no such folder`);
    // One realpath for every alias of the out dir (a junction, another case), so rows and the lock are shared (test 31).
    const out = fs.realpathSync.native(given);
    const stdout = withLock(out, () => RUN[args.mode](args, out, cwd, (m) => notes.push(m)));
    return { code: 0, stdout, stderr: notes.map((n) => `${n}\n`).join('') };
  } catch (err) {
    return { code: 1, stdout: '', stderr: [...notes, err.message].map((n) => `${n}\n`).join('') };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
