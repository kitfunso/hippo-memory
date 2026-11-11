#!/usr/bin/env node
/** Z0 pins check: before a launch or a regrade, the pinned files and the hippo build must be the ones the pins file names.
 * Exit 0 on a pass, 3 on a mismatch (one `PINS:` line each), 1 on bad usage. A `tree:<role>=<dir>` role pins a folder through its sha256.txt manifest. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EFFORTS } from './arms.mjs';
import { hippoBuild, pinMismatches } from './pins.mjs';

export const MANIFEST = 'sha256.txt';
const EFFORT_VARIANTS = ['low', 'high'];
const BUILD_KEYS = ['hippoCommit', 'hippoDistHash'];
const USAGE = 'usage: z0-pins-check.mjs --pins FILE --checkout DIR [--roles FILE] [--poetry DIR] [tree:]<role>=<path>...\n'
  + `       z0-pins-check.mjs --write FILE --checkout DIR --set effort=<${EFFORTS.join('|')}> [--set key=value ...] [--roles FILE] [--poetry DIR] [tree:]<role>=<path>...\n`
  + '       z0-pins-check.mjs --manifest DIR\n'
  + '       z0-pins-check.mjs --manifest-check DIR\n'
  + 'exit 0 pass, 3 pins mismatch, 1 bad usage';
const FLAGS = new Map([['--pins', 'pins'], ['--write', 'write'], ['--checkout', 'checkout'], ['--manifest', 'manifest'], ['--manifest-check', 'manifestCheck'],
  ['--roles', 'rolesFile'], ['--poetry', 'poetry']]);
const POETRY_VERSION = /^Poetry \(version ([^)\s]+)\)$/;
const POETRY_TIMEOUT_MS = 30_000;
const ROLE_LINE = /^[^=]+=.+$/;
const MANIFEST_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

const fileHash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A stop that exits 3, its message already a `PINS:` line. */
class PinsStop extends Error {}

const poetryExe = (dir) => path.join(dir, 'Scripts', 'poetry.exe');

/** No shell, so the folder's own poetry.exe runs and nothing on PATH can stand in for it; the timeout stops a hung run from holding the check. */
const defaultPoetryLine = (dir) => execFileSync(poetryExe(dir), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: POETRY_TIMEOUT_MS });

/** The version in the first line `poetry.exe --version` prints, or the `PINS:` line that says why there is none. */
function readPoetry(dir, poetryLine) {
  let first;
  try {
    first = String(poetryLine(dir)).split('\n')[0].trim();
  } catch (e) {
    const why = String(e.stderr ?? '').trim().split('\n')[0];
    return { version: null, problem: `PINS: poetryVersion: ${poetryExe(dir)} did not run: ${e.message.split('\n')[0]}${why === '' ? '' : ` (stderr: ${why})`}` };
  }
  const m = POETRY_VERSION.exec(first);
  if (m === null) return { version: null, problem: `PINS: poetryVersion: ${dir} printed ${JSON.stringify(first)}, not "Poetry (version <v>)"` };
  return { version: m[1], problem: null };
}

/** Every file under `dir` but its own manifest, as forward-slash paths in code-unit order; a link stops the read, since its target sits outside the hash. */
function filesUnder(dir) {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  const link = entries.find((e) => e.isSymbolicLink());
  if (link !== undefined) throw new PinsStop(`PINS: ${path.join(link.parentPath, link.name)} is a link; a pinned folder holds files only`);
  return entries.filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).filter((f) => f !== MANIFEST).sort();
}

/** One `<sha256>  <path>` line per file, LF line ends and a final newline: the one format the writer and the check share. */
export const manifestText = (dir) => filesUnder(dir).map((f) => `${fileHash(path.join(dir, f))}  ${f}\n`).join('');

/** The `PINS:` lines for a folder that differs from its manifest: a changed, a missing or an unlisted file, each named. */
function treeProblems(role, dir) {
  const manifest = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifest)) return [`PINS: ${role}: ${manifest} does not exist; write it with --manifest`];
  const listed = new Map();
  const problems = [];
  fs.readFileSync(manifest, 'utf8').split('\n').slice(0, -1).forEach((line, i) => {
    const m = MANIFEST_LINE.exec(line);
    if (m === null) problems.push(`PINS: ${role}: ${MANIFEST} line ${i + 1} is not "<sha256>  <path>"`);
    else listed.set(m[2], m[1]);
  });
  for (const [file, hash] of listed) {
    const abs = path.join(dir, file);
    if (!fs.existsSync(abs)) problems.push(`PINS: ${role}: ${file} is missing`);
    else if (fileHash(abs) !== hash) problems.push(`PINS: ${role}: ${file} changed`);
  }
  for (const file of filesUnder(dir)) if (!listed.has(file)) problems.push(`PINS: ${role}: ${file} is not in ${MANIFEST}`);
  return problems;
}

/** One pinned file or folder: its `sha256:<role>` value, and what differs from it. */
function roleState(spec, cwd) {
  const [kind, rest] = spec.startsWith('tree:') ? ['tree', spec.slice(5)] : ['file', spec];
  const at = rest.indexOf('=');
  if (at < 1 || at === rest.length - 1) throw new Error(`${spec}: a role is [tree:]<role>=<path>\n${USAGE}`);
  const [role, target] = [rest.slice(0, at), path.resolve(cwd, rest.slice(at + 1))];
  if (!fs.existsSync(target)) return { role, hash: null, problems: [`PINS: ${role}: ${target} does not exist`] };
  if (kind === 'file') return { role, hash: fileHash(target), problems: [] };
  const problems = treeProblems(role, target);
  return { role, hash: fs.existsSync(path.join(target, MANIFEST)) ? fileHash(path.join(target, MANIFEST)) : null, problems };
}

function parseArgs(argv) {
  const args = { pins: null, write: null, checkout: null, manifest: null, manifestCheck: null, rolesFile: null, poetry: null, set: [], roles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args.roles.push(a);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
    if (a === '--set') {
      // A sha256: key is each role's own file hash; a --set value would be written unchecked.
      if (value.startsWith('sha256:')) throw new Error(`--set ${value.split('=')[0]}: a sha256: key is written from its <role>=<path> argument, so --set cannot name one`);
      args.set.push(value);
    } else if (!FLAGS.has(a)) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else if (args[FLAGS.get(a)] !== null) throw new Error(`${a} given twice`);
    else args[FLAGS.get(a)] = value;
  }
  const modes = [args.pins, args.write, args.manifest, args.manifestCheck].filter((m) => m !== null);
  if (modes.length !== 1) throw new Error(`give exactly one of --pins, --write, --manifest and --manifest-check\n${USAGE}`);
  if (args.manifest === null && args.manifestCheck === null && args.checkout === null) throw new Error(`--checkout is needed\n${USAGE}`);
  if (args.manifestCheck !== null) checkManifestCheckAlone(args);
  if (args.write !== null) checkWriteSets(setPairs(args.set));
  return args;
}

const setPairs = (sets) => sets.map((s) => {
  const at = s.indexOf('=');
  if (at < 1) throw new Error(`--set ${s}: a pair is key=value`);
  return [s.slice(0, at), s.slice(at + 1)];
});

/** The --set pairs of a --write, refused when one names a key the build or the poetry folder computes, repeats a key, or leaves out the effort the main file pins or gives one outside EFFORTS. */
function checkWriteSets(pairs) {
  const keys = pairs.map(([k]) => k);
  const built = keys.find((k) => BUILD_KEYS.includes(k));
  if (built !== undefined) throw new Error(`--set ${built}: the build computes it from --checkout, so --set cannot name it`);
  if (keys.includes('poetryVersion')) throw new Error('--set poetryVersion: --poetry writes it from the poetry folder, so --set cannot name it');
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice !== undefined) throw new Error(`--set ${twice} is given twice; each key takes one value`);
  const effort = pairs.find(([k, v]) => k === 'effort' && v !== '');
  if (effort === undefined) throw new Error('--write needs --set effort=<value>: the main pins file pins the effort and each effort file overrides it');
  if (!EFFORTS.includes(effort[1])) throw new Error(`--set effort=${effort[1]}: effort is one of ${EFFORTS.join(', ')}`);
}

/** Why a --roles line is no role, or null; roleState's rule, applied here so the stop names the file and the line. */
function lineProblem(line) {
  if (line.includes('\r')) return 'holds a carriage return; the file takes LF line ends';
  if (line === '') return 'is blank';
  return ROLE_LINE.test(line.startsWith('tree:') ? line.slice(5) : line) ? null : 'is not [tree:]<role>=<path>';
}

/** The role arguments of a --roles file: one `[tree:]<role>=<path>` per LF line, read as if given on the command line. */
function rolesFromFile(file, cwd) {
  const lines = fs.readFileSync(path.resolve(cwd, file), 'utf8').replace(/^﻿/, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const problems = lines.map(lineProblem);
  const at = problems.findIndex((p) => p !== null);
  if (at >= 0) throw new Error(`--roles ${file}: line ${at + 1} ${problems[at]}`);
  return lines;
}

/** --manifest-check reads one folder and its own manifest, so an input meant for the pins check beside it is a mistake to name, not to ignore. */
function checkManifestCheckAlone(args) {
  const beside = [
    args.roles.length > 0 ? `role argument ${args.roles[0]}` : null, args.rolesFile !== null ? '--roles' : null, args.poetry !== null ? '--poetry' : null,
    args.set.length > 0 ? '--set' : null, args.checkout !== null ? '--checkout' : null,
  ].find((name) => name !== null);
  if (beside !== undefined) throw new Error(`--manifest-check cannot be given with ${beside}; it checks one folder against its own manifest`);
}

function checkPins(args, cwd, states, poetry) {
  const pins = JSON.parse(fs.readFileSync(path.resolve(cwd, args.pins), 'utf8'));
  const checkout = path.resolve(cwd, args.checkout);
  const build = hippoBuild(checkout);
  const problems = states.flatMap((s) => s.problems);
  for (const s of states) {
    if (s.hash !== null && pins[`sha256:${s.role}`] === undefined) problems.push(`PINS: ${s.role}: ${args.pins} has no key sha256:${s.role}`);
    else if (s.hash !== null && pins[`sha256:${s.role}`] !== s.hash) problems.push(`PINS: ${s.role} is pinned ${pins[`sha256:${s.role}`]}, this file has ${s.hash}`);
  }
  // The prereg Freeze row (:118) hashes every pinned file again, so a pin that no role on the call names is a stop, not a skip.
  const checked = new Set(states.map((s) => s.role));
  for (const key of Object.keys(pins)) {
    const role = key.slice('sha256:'.length);
    if (key.startsWith('sha256:') && !checked.has(role)) problems.push(`PINS: ${role} is pinned but not checked; pass ${role}=<path>`);
  }
  if (poetry === null && pins.poetryVersion !== undefined) problems.push('PINS: poetryVersion is pinned but not checked; pass --poetry <dir>');
  const actual = { hippoCommit: build.hippoCommit, hippoDistHash: build.hippoDistHash };
  if (poetry !== null && poetry.problem !== null) problems.push(poetry.problem);
  else if (poetry !== null) actual.poetryVersion = poetry.version;
  for (const line of pinMismatches(pins, actual)) problems.push(`PINS: ${line}`);
  if (build.hippoDirty) problems.push(`PINS: the hippo checkout ${checkout} has changes beyond its commit, so the commit does not name the build`);
  return problems;
}

function writePins(args, cwd, states, poetry) {
  const build = hippoBuild(path.resolve(cwd, args.checkout));
  const pins = {
    ...Object.fromEntries(setPairs(args.set)), ...Object.fromEntries(states.map((s) => [`sha256:${s.role}`, s.hash])),
    hippoCommit: build.hippoCommit, hippoDistHash: build.hippoDistHash,
  };
  if (poetry !== null) pins.poetryVersion = poetry.version;
  const file = path.resolve(cwd, args.write);
  // An effort file takes its pins file's name, so two pins files in one folder keep their own.
  const { dir, name } = path.parse(file);
  const out = [[file, pins], ...EFFORT_VARIANTS.map((effort) => [path.join(dir, `${name}-effort-${effort}.json`), { ...pins, effort }])];
  for (const [f, body] of out) fs.writeFileSync(f, `${JSON.stringify(body, null, 2)}\n`);
  return out.map(([f]) => f);
}

/** The whole CLI as a function of argv and cwd, so tests drive it without a child process; `deps.poetryLine` is their seam, since Node cannot spawn a stub script as poetry.exe. */
export function runCli(argv, cwd = process.cwd(), deps = { poetryLine: defaultPoetryLine }) {
  try {
    const args = parseArgs(argv);
    if (args.manifest !== null) {
      const dir = path.resolve(cwd, args.manifest);
      fs.writeFileSync(path.join(dir, MANIFEST), manifestText(dir));
      return { code: 0, stdout: `wrote ${path.join(dir, MANIFEST)}: ${filesUnder(dir).length} files\n`, stderr: '' };
    }
    if (args.manifestCheck !== null) {
      const dir = path.resolve(cwd, args.manifestCheck);
      if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
      const problems = treeProblems(dir, dir);
      if (problems.length > 0) return { code: 3, stdout: '', stderr: `${problems.join('\n')}\n` };
      return { code: 0, stdout: `manifest ok: ${filesUnder(dir).length} files in ${dir}\n`, stderr: '' };
    }
    const fromFile = args.rolesFile === null ? [] : rolesFromFile(args.rolesFile, cwd);
    const states = [...fromFile, ...args.roles].map((r) => roleState(r, cwd));
    const twice = states.find((s, i) => states.findIndex((t) => t.role === s.role) !== i);
    if (twice !== undefined) throw new Error(`role ${twice.role} is given twice; a role names one file or folder\n${USAGE}`);
    const poetry = args.poetry === null ? null : readPoetry(path.resolve(cwd, args.poetry), deps.poetryLine);
    if (args.pins !== null) {
      const problems = checkPins(args, cwd, states, poetry);
      if (problems.length > 0) return { code: 3, stdout: '', stderr: `${problems.join('\n')}\n` };
      return { code: 0, stdout: `pins ok: ${states.length} files and folders, hippo build ${hippoBuild(path.resolve(cwd, args.checkout)).hippoCommit}\n`, stderr: '' };
    }
    const problems = states.flatMap((s) => s.problems);
    if (poetry !== null && poetry.problem !== null) problems.push(poetry.problem);
    if (problems.length > 0) return { code: 3, stdout: '', stderr: `${problems.join('\n')}\n` };
    return { code: 0, stdout: `${writePins(args, cwd, states, poetry).map((f) => `wrote ${f}`).join('\n')}\n`, stderr: '' };
  } catch (e) {
    return { code: e instanceof PinsStop ? 3 : 1, stdout: '', stderr: `${e.message}\n` };
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
