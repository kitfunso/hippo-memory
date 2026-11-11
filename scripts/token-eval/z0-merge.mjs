#!/usr/bin/env node
/** Round 4 prereg item 9 (Amendment E as a standing rule): drops each leaked (sequence, seed) from a first run and keeps its rerun folder apart,
 * so a read joins them. The kept records are the first run's lines unchanged. Exit 0 on a merge, 1 on bad input, 3 on a regraded first run it was not told to read. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { Stop, linesOf, parseFlags, parseOrNull, readJson, runCommand, runMain } from './free-cli.mjs';
import { sha256 } from './z0-blind.mjs';
import { readVoids } from './z0-filters.mjs';
import { LEAKS_SCHEMA, MERGE_SCHEMA, OFFPIN_SCHEMA, isString, parsePlan, runKey } from './z0-records.mjs';

const USAGE = 'usage: z0-merge.mjs --first OUT --leaks FILE --first-off-pin FILE [--rerun-of OUT ...] --out DIR [--first-runs FILE]';
const SPEC = { values: ['--first', '--leaks', '--first-off-pin', '--out', '--first-runs'], lists: ['--rerun-of'], required: ['--first', '--leaks', '--first-off-pin', '--out'] };
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** The manifest `z0-merge` wrote, checked; G3 reads its `firstRun` counts. */
export function readMergeManifest(file) {
  const m = readJson(file);
  if (m.schema !== MERGE_SCHEMA) throw new Error(`${file}: schema must be "${MERGE_SCHEMA}"`);
  if (!isCount(m.firstRun?.plannedSequenceSeeds) || !isCount(m.firstRun?.leakedSequenceSeeds)) throw new Error(`${file}: firstRun needs plannedSequenceSeeds and leakedSequenceSeeds (counts)`);
  return m;
}

/** The leak list, checked against the runs file the merge reads. */
function readLeakList(file, runsSha) {
  const body = readJson(file);
  if (body.schema !== LEAKS_SCHEMA) throw new Error(`${file}: schema must be "${LEAKS_SCHEMA}"`);
  if (!Array.isArray(body.leaks) || !body.leaks.every((l) => isString(l?.sequence) && Number.isInteger(l.seed) && l.seed >= 1)) throw new Error(`${file}: leaks must be a list of { sequence, seed }`);
  if (body.leaks.length === 0) throw new Error(`${file}: it lists no leak, so there is nothing to merge`);
  if (body.runs?.sha256 !== runsSha) throw new Error(`${file}: was written for another runs file (${body.runs?.file}); list the leaks again from the file this merge reads`);
  return body.leaks;
}

/** The (sequence, seed) keys a folder's records and plan hold. */
function covered(dir) {
  const keys = new Set();
  for (const [name, read] of [['runs.jsonl', (t) => linesOf(t).map(parseOrNull)], ['plan.json', (t) => parsePlan(t, 'plan.json')]]) {
    const file = path.join(dir, name);
    for (const x of read(fs.readFileSync(file, 'utf8'))) {
      if (x === null) throw new Error(`${file}: a line is not JSON`);
      keys.add(runKey(x.sequence, x.seed));
    }
  }
  return keys;
}

/** Each rerun folder holds leaked seeds only and each leaked (sequence, seed) has one folder. */
function checkReruns(dirs, leaks) {
  const leaked = new Map(leaks.map((l) => [runKey(l.sequence, l.seed), l]));
  const taken = new Map();
  for (const dir of dirs) {
    const keys = [...covered(dir)];
    const hit = keys.filter((k) => leaked.has(k));
    if (hit.length === 0) throw new Error(`${dir}: is not a rerun of a leaked seed`);
    if (hit.length < keys.length) throw new Error(`${dir}: holds seeds other than ${hit.map((k) => leaked.get(k).seed).join(', ')}`);
    for (const k of hit) {
      if (taken.has(k)) throw new Error(`${leaked.get(k).sequence} seed ${leaked.get(k).seed} is held by two --rerun-of folders: ${taken.get(k)} and ${dir}`);
      taken.set(k, dir);
    }
  }
  const missing = leaks.find((l) => !taken.has(runKey(l.sequence, l.seed)));
  if (missing !== undefined) throw new Error(`${missing.sequence} seed ${missing.seed} has no --rerun-of folder`);
}

/** The first run's runs file: `--first-runs`, else runs.jsonl; a runs.regraded.jsonl beside it with no `--first-runs` stops the merge. */
function firstRunsFile(first, given, cwd) {
  if (given !== null) return path.resolve(cwd, given);
  const regraded = path.join(first, 'runs.regraded.jsonl');
  if (fs.existsSync(regraded)) throw new Stop(`STOP: ${regraded} exists beside --first; pass --first-runs with the runs file the leak list and the off-pin file were written for`);
  return path.join(first, 'runs.jsonl');
}

const sortedSeeds = (leaks) => Object.fromEntries([...new Set(leaks.map((l) => l.sequence))].sort().map((s) => [s, leaks.filter((l) => l.sequence === s).map((l) => l.seed).sort((a, b) => a - b)]));

/** The first run's plan cells as written, and the (sequence, seed)s they hold; every leak must be among them. */
function readFirstPlan(first, leaks, leaksFile) {
  const file = path.join(first, 'plan.json');
  const text = fs.readFileSync(file, 'utf8');
  parsePlan(text, file);
  const cells = JSON.parse(text);
  const planned = new Set(cells.map((c) => runKey(c.sequence, c.seed)));
  const absent = leaks.find((l) => !planned.has(runKey(l.sequence, l.seed)));
  if (absent !== undefined) throw new Error(`${leaksFile}: ${absent.sequence} seed ${absent.seed} is not in ${file}`);
  return { cells, planned };
}

/** The first run's record lines outside the leaked runs, byte for byte. */
function keptLines(runsFile, leaked) {
  return linesOf(fs.readFileSync(runsFile, 'utf8')).filter((l, i) => {
    const r = parseOrNull(l);
    if (r === null) throw new Error(`${runsFile} line ${i + 1}: not JSON`);
    return !leaked.has(runKey(r.sequence, r.seed));
  });
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  return runCommand(() => {
    const args = parseFlags(argv, SPEC, USAGE);
    const [first, out] = [path.resolve(cwd, args.first), path.resolve(cwd, args.out)];
    const runsFile = firstRunsFile(first, args.firstRuns, cwd);
    const [leaksFile, offPinFile] = [path.resolve(cwd, args.leaks), path.resolve(cwd, args.firstOffPin)];
    const leaks = readLeakList(leaksFile, sha256(runsFile));
    const leaked = new Set(leaks.map((l) => runKey(l.sequence, l.seed)));
    // The void objects as written, so the merged file carries each field the first run's did.
    const written = readJson(offPinFile).voids;
    const voids = readVoids(offPinFile, { cwd, runHashes: [sha256(runsFile)] }).map((v) => written[v.index]).filter((v) => !leaked.has(runKey(v.sequence, v.seed)));
    checkReruns(args.rerunOf.map((d) => path.resolve(cwd, d)), leaks);
    const { cells, planned } = readFirstPlan(first, leaks, leaksFile);
    const kept = keptLines(runsFile, leaked);
    // parsePlan refuses an empty plan, so a first run that leaked whole keeps no runs, plan or off-pin file; the manifest alone carries its counts.
    const whole = leaked.size === planned.size;
    if (whole) {
      // An earlier merge into this folder left files the read set would read beside the manifest; merge.json goes too, so an interrupted run leaves no manifest.
      for (const name of ['merge.json', 'runs.jsonl', 'plan.json', 'off-pin.json']) fs.rmSync(path.join(out, name), { force: true });
    } else {
      const runsOut = path.join(out, 'runs.jsonl');
      writeFileAtomic(runsOut, kept.map((l) => `${l}\n`).join(''));
      writeFileAtomic(path.join(out, 'plan.json'), JSON.stringify(cells.filter((c) => !leaked.has(runKey(c.sequence, c.seed)))));
      writeFileAtomic(path.join(out, 'off-pin.json'), `${JSON.stringify({ schema: OFFPIN_SCHEMA, runs: [{ dir: out, file: 'runs.jsonl', sha256: sha256(runsOut) }], voids }, null, 2)}\n`);
    }
    const manifest = {
      schema: MERGE_SCHEMA, first: { dir: path.dirname(runsFile), file: path.basename(runsFile), sha256: sha256(runsFile) },
      hashes: [{ role: 'leaks', file: leaksFile, sha256: sha256(leaksFile) }, { role: 'first-off-pin', file: offPinFile, sha256: sha256(offPinFile) }],
      droppedSeeds: sortedSeeds(leaks), firstRun: { plannedSequenceSeeds: planned.size, leakedSequenceSeeds: leaked.size },
    };
    // Written last, so a folder with a merge.json holds its other files whole.
    writeFileAtomic(path.join(out, 'merge.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return `merged ${kept.length} records, dropped ${leaked.size} leaked seeds, ${whole ? 0 : voids.length} voids kept\n`;
  });
}

runMain(import.meta.url, runCli);
