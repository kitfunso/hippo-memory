#!/usr/bin/env node
/** Round 4 Read set contract: one file of input pairs, so every read loads each folder's own off-pin file beside the runs file it names.
 * A line is argv tokens split by one space with absolute paths. Exit 0 on a file, 1 on bad input, 3 on a stop the plan names. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { readSealed, writeFileAtomic } from './atomic-write.mjs';
import { Stop, linesOf, parseFlags, readJson, runCommand, runMain } from './free-cli.mjs';
import { readMergeManifest } from './z0-merge.mjs';
import { isString } from './z0-records.mjs';

const USAGE = 'usage: z0-read-set.mjs --root DIR --batches 1|1,2|1,2,raise --out FILE';
const SPEC = { values: ['--root', '--batches', '--out'], required: ['--root', '--batches', '--out'] };
const BATCHES = new Map([['1', ['batch1']], ['1,2', ['batch1', 'batch2']], ['1,2,raise', ['batch1', 'batch2', 'raise']]]);
// The raise never caps below the base seeds.
const MAX_SEED_FLOOR = 3;
const INPUT_FLAGS = ['--runs', '--plan', '--off-pin'];
const LINE_FLAGS = [...INPUT_FLAGS, '--merge-manifest', '--max-seed'];

const keysOf = (pins, field, file) => {
  if (!isString(pins[field]) || pins[field].trim() === '') throw new Error(`${file}: ${field} must be a comma list of keys`);
  return pins[field].split(',').map((k) => k.trim()).filter(Boolean);
};

/** The folder name `<root>/<dir>/done/<name>` holds; a missing marker stops, a malformed one is bad input. */
function marker(root, dir, name) {
  const file = `${root}/${dir}/done/${name}`;
  if (!fs.existsSync(file)) throw new Stop(`STOP: ${dir}/done/${name} is missing, so the unit has not completed`);
  const text = fs.readFileSync(file, 'utf8');
  if (!/^[^\n\\/]+\n$/.test(text)) throw new Error(`${file}: a marker holds one folder name and ends with a line feed`);
  return text.slice(0, -1);
}

function noRegraded(dir) {
  if (fs.existsSync(`${dir}/runs.regraded.jsonl`)) throw new Stop(`STOP: ${dir}/runs.regraded.jsonl exists; the round 4 reads never take a regraded runs file`);
}

const own = (dir) => `--runs ${dir}/run/runs.jsonl --plan ${dir}/run/plan.json --off-pin ${dir}/off-pin.json`;

/** The line of a leaked key's merged folder. Its manifest alone decides the shape: a merge that dropped every first-run seed left no runs, plan or off-pin file, so its line holds the manifest (G3 still counts it);
 * any other merge needs all three files, and a missing one stops. */
function mergedLine(root, dir, key, wave) {
  const name = `merged/${dir}/${key}-w${wave}`;
  const merged = `${root}/${name}`;
  if (!fs.existsSync(`${merged}/merge.json`)) throw new Stop(`STOP: ${name} is missing or has no merge.json; run z0-merge`);
  noRegraded(merged);
  const { firstRun } = readMergeManifest(`${merged}/merge.json`);
  const manifest = `--merge-manifest ${merged}/merge.json`;
  if (firstRun.leakedSequenceSeeds === firstRun.plannedSequenceSeeds) return manifest;
  const absent = ['runs.jsonl', 'plan.json', 'off-pin.json'].find((f) => !fs.existsSync(`${merged}/${f}`));
  if (absent !== undefined) throw new Stop(`STOP: ${name}/${absent} is missing; run z0-merge`);
  return `--runs ${merged}/runs.jsonl --plan ${merged}/plan.json --off-pin ${merged}/off-pin.json ${manifest}`;
}

/** The lines of one key: its merged folder when its first run leaked a seed, else its completed attempt; then each leak rerun's completed attempt. */
function keyLines(root, dir, key, wave) {
  const attempt = marker(root, dir, key);
  const seeds = [...new Set(readJson(`${root}/${dir}/${attempt}/leaks.json`).leaks.map((l) => l.seed))].sort((a, b) => a - b);
  const lines = [];
  if (seeds.length > 0) {
    lines.push(mergedLine(root, dir, key, wave));
  } else {
    noRegraded(`${root}/${dir}/${attempt}/run`);
    lines.push(own(`${root}/${dir}/${attempt}`));
  }
  for (const seed of seeds) {
    const rerun = marker(root, dir, `${key}-e${seed}`);
    noRegraded(`${root}/${dir}/${rerun}/run`);
    lines.push(own(`${root}/${dir}/${rerun}`));
  }
  return lines;
}

/** The raise's lines: none under raise/NONE, a stop for a key with no marker and no folder, else each key's lines at wave 2. */
function raiseLines(root, keys) {
  if (fs.existsSync(`${root}/raise/NONE`)) return [];
  return keys.flatMap((key) => {
    if (!fs.existsSync(`${root}/raise/done/${key}`) && !fs.existsSync(`${root}/raise/${key}-w2`)) throw new Stop(`STOP: raise/${key}-w2 is missing and raise/NONE is absent`);
    return keyLines(root, 'raise', key, 2);
  });
}

/** `--max-seed` from the sealed raise file, floored; null with no file. */
function maxSeedLine(root) {
  const sealed = readSealed(`${root}/raise/max-seed.json`);
  if (sealed === null) return [];
  if (!Number.isInteger(sealed.maxSeed) || sealed.maxSeed < 1) throw new Error(`${root}/raise/max-seed.json: maxSeed must be a positive integer`);
  return [`--max-seed ${Math.max(MAX_SEED_FLOOR, sealed.maxSeed)}`];
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  return runCommand(() => {
    const args = parseFlags(argv, SPEC, USAGE);
    const dirs = BATCHES.get(args.batches);
    if (dirs === undefined) throw new Error(`--batches must be 1, 1,2 or 1,2,raise, got ${args.batches}\n${USAGE}`);
    const root = path.resolve(cwd, args.root).replace(/\\/g, '/').replace(/\/$/, '');
    if (/\s/.test(root)) throw new Error(`--root ${root}: a path with a space cannot sit in a one-space-split line`);
    const pinsFile = `${root}/pins-r4.json`;
    const pins = readJson(pinsFile);
    const keys = { batch1: keysOf(pins, 'batch1Keys', pinsFile), batch2: dirs.includes('batch2') ? keysOf(pins, 'batch2Keys', pinsFile) : [] };
    keys.raise = [...keys.batch1, ...keys.batch2];
    const lines = [...(dirs.includes('raise') ? maxSeedLine(root) : [])];
    for (const dir of dirs) lines.push(...(dir === 'raise' ? raiseLines(root, keys.raise) : keys[dir].flatMap((key) => keyLines(root, dir, key, 1))));
    writeFileAtomic(path.resolve(cwd, args.out),`${lines.join('\n')}\n`);
    return `${lines.length} lines\n`;
  });
}

/** The pairs of a read-set file and its `--max-seed` line; every parser of it comes through here. A merge manifest alone is a pair with no runs, plan or off-pin file.
 * @returns {{maxSeed: number | null, pairs: {runs: string | null, plan: string | null, offPin: string | null, mergeManifest: string | null}[]}} */
export function readReadSet(file) {
  let maxSeed = null;
  const pairs = [];
  for (const line of linesOf(fs.readFileSync(file, 'utf8'))) {
    const tokens = line.split(' ');
    const flags = new Map();
    for (let i = 0; i < tokens.length; i += 2) flags.set(tokens[i], tokens[i + 1]);
    if (tokens.length % 2 !== 0 || flags.size * 2 !== tokens.length) throw new Error(`${file}: a line is flag and value pairs, got "${line}"`);
    const unknown = [...flags.keys()].find((f) => !LINE_FLAGS.includes(f));
    if (unknown !== undefined) throw new Error(`${file}: unknown flag ${unknown} in "${line}"`);
    if (flags.has('--max-seed')) {
      if (flags.size > 1 || !/^\d+$/.test(flags.get('--max-seed')) || Number(flags.get('--max-seed')) < MAX_SEED_FLOOR) throw new Error(`${file}: a --max-seed line holds that flag alone, with an integer of ${MAX_SEED_FLOOR} or more, got "${line}"`);
      maxSeed = Number(flags.get('--max-seed'));
      continue;
    }
    const given = INPUT_FLAGS.filter((f) => flags.has(f));
    if (given.length === 0 && !flags.has('--merge-manifest')) throw new Error(`${file}: a line needs ${INPUT_FLAGS.join(', ')} or --merge-manifest, got "${line}"`);
    if (given.length > 0 && given.length < INPUT_FLAGS.length) throw new Error(`${file}: a line needs ${INPUT_FLAGS.find((f) => !flags.has(f))}, got "${line}"`);
    pairs.push({ runs: flags.get('--runs') ?? null, plan: flags.get('--plan') ?? null, offPin: flags.get('--off-pin') ?? null, mergeManifest: flags.get('--merge-manifest') ?? null });
  }
  return { maxSeed, pairs };
}

runMain(import.meta.url, runCli);
