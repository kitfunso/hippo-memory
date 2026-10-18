#!/usr/bin/env node
/** Z0 Amendment 2 item 5, the blind seed rule: how many seeds the rule arms run after wave 1. It reads wave 1 only (seeds 1 to 3)
 * and prints seed counts, never a mean, estimate, sign or spread, so it cannot see the effect. Exit 0 on a result (a stop too), 1 on bad input. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pooledComponents } from '../../dist/eval/repository-t.js';
import { loadInputs } from './z0-analyze.mjs';
import { inputHashes, sha256 } from './z0-blind.mjs';
import { abandonedRuns, filterRecords } from './z0-filters.mjs';
import { CODINGS, codexApply, inSets, repeatMistakeUnits, taskUnits, withoutRuns } from './z0-hypotheses.mjs';
import { validateCorpus, isString } from './z0-records.mjs';
import { calibrate } from './z0-size.mjs';
import { SEEDS, SEED_CAP, TARGET_Z, harmSizer, seedsNeeded } from './z0-size-sim.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = ['scripts/token-eval/z0-seed-rule.mjs', 'scripts/token-eval/z0-size-sim.mjs'];
const DEFAULTS = { minimumEffect: 0.15, targetZ: TARGET_Z, cap: SEED_CAP, power: 0.8, sims: 2_000, seed: 1, bound: 0.8 };
const STOP_NOTE = 'the run stops after wave 1 and scores nothing; size the next run with z0-size.mjs on these records as calibration (prereg line 215)';
const USAGE = 'usage: z0-seed-rule.mjs --runs FILE [--runs FILE ...] --plan FILE [--plan FILE ...] --prices FILE [--drop-list FILE] '
  + '[--minimum-effect 0.15] [--target-z 3.5] [--cap 9] [--power 0.8] [--sims 2000] [--seed 1] [--bound 0.8] [--out FILE]';

const number = (flag, ok, what) => (v) => {
  const n = Number(v);
  if (!ok(n)) throw new Error(`${flag} must be ${what}, got ${v}`);
  return n;
};
const integer = (flag, min) => number(flag, (n) => Number.isInteger(n) && n >= min, `an integer of at least ${min}`);
const fraction = (flag) => number(flag, (n) => n > 0 && n < 1, 'between 0 and 1');
const FLAGS = new Map([
  ['--prices', ['prices', String]], ['--drop-list', ['dropList', String]], ['--out', ['out', String]],
  ['--minimum-effect', ['minimumEffect', fraction('--minimum-effect')]],
  ['--target-z', ['targetZ', number('--target-z', (n) => Number.isFinite(n) && n > 0, 'a positive number')]],
  ['--cap', ['cap', integer('--cap', SEEDS)]], ['--power', ['power', fraction('--power')]],
  ['--sims', ['sims', integer('--sims', 1)]], ['--seed', ['seed', integer('--seed', 1)]], ['--bound', ['bound', fraction('--bound')]],
]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { runs: [], plan: [], prices: null, dropList: null, grading: null, out: null, help: false, ...DEFAULTS };
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

/** H1 or H2 seeds: the larger of the two codings' counts, null when the cap misses. A coding with no fitted repository is bad
 * input, told apart from a cap miss by the pooled fit alone, so no figure reaches the message. */
function repeatSeeds(name, scored, [armT, armC], keep, opts) {
  const counts = CODINGS.map((coding) => {
    const { units } = repeatMistakeUnits(scored, armT, armC, coding, keep);
    if (pooledComponents(units) === null) throw new Error(`${name}: needs ${armT} and ${armC} units in a repository with 2 families and 2 seeds`);
    return seedsNeeded(units, opts.minimumEffect, { cap: opts.cap, targetZ: opts.targetZ });
  });
  return counts.includes(null) ? null : Math.max(...counts);
}

/** Set N's design from the units: the repositories present, and the mean distinct tasks per repository (units repeat per seed). */
function harmDesign(units) {
  const tasks = new Map();
  for (const u of units) tasks.set(u.repo, (tasks.get(u.repo) ?? new Set()).add(u.family));
  const counts = [...tasks.values()].map((t) => t.size);
  return { repos: tasks.size, tasks: Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) };
}

/** H4 seeds: the fewest from SEEDS to the cap at which the harm gate passes with `power`, on the sizer's own calibration. */
function harmSeeds(filtered, prices, opts) {
  const cal = calibrate(filtered, prices, opts.bound).H4;
  if (cal.sim === undefined) throw new Error(`H4: ${cal.reason}`);
  const design = harmDesign(taskUnits(filtered.scored, 'A2', 'A1', prices['claude-code'], inSets('N')));
  for (let seeds = SEEDS; seeds <= opts.cap; seeds++) {
    if (harmSizer(cal.sim, { sims: opts.sims, seed: opts.seed, seeds })(design).pass >= opts.power) return seeds;
  }
  return null;
}

/** The seeds per rule arm from wave-1 records alone. Abandoned runs are left out, as in the sizer.
 * @param {any[]} records @param {any[]} planCells @param {any} prices @param {any} opts */
export function seedRule(records, planCells, prices, opts) {
  validateCorpus(records, planCells);
  const abandoned = abandonedRuns(records, planCells);
  const filtered = filterRecords(withoutRuns(records, abandoned), withoutRuns(planCells, abandoned), { dropList: opts.dropList ?? null });
  if (filtered.scored.some((r) => r.seed > SEEDS)) throw new Error(`the rule reads wave 1 only: a scored record has a seed above ${SEEDS}`);
  const hasX = ['X2', 'X3'].every((a) => filtered.arms.includes(a));
  const perHypothesis = { H1: repeatSeeds('H1', filtered.scored, ['A2', 'A1'], inSets('R'), opts) };
  if (hasX) perHypothesis.H2 = repeatSeeds('H2', filtered.scored, ['X2', 'X3'], codexApply, opts);
  perHypothesis.H4 = harmSeeds(filtered, prices, opts);
  const short = Object.entries(perHypothesis).filter(([, n]) => n === null).map(([h]) => `${h} needs more than ${opts.cap} seeds`);
  if (short.length > 0) return { seeds: null, perHypothesis, stop: true, reasons: [...short, STOP_NOTE] };
  const rule = Math.max(perHypothesis.H1, perHypothesis.H4);
  const seeds = { A1: rule, A2: rule, A5: rule };
  if (hasX) Object.assign(seeds, { X2: perHypothesis.H2, X3: perHypothesis.H2 });
  return { seeds, perHypothesis, stop: false, reasons: [] };
}

const summary = (r) => (r.stop ? `stop: ${r.reasons.join('; ')}` : `seeds ${Object.entries(r.seeds).map(([arm, n]) => `${arm} ${n}`).join(', ')}`);

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  const fail = (message) => ({ code: 1, stdout: '', stderr: `${message}\n` });
  let report;
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    const inputs = loadInputs(args, cwd);
    const settings = { ...Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, args[k]])), firstWave: SEEDS };
    const result = seedRule(inputs.records, inputs.planCells, inputs.prices, { ...settings, dropList: inputs.dropList });
    const hashes = [...inputHashes(args, cwd), ...SOURCES.map((f) => ({ role: 'source', file: f, sha256: sha256(path.join(REPO, f)) }))];
    report = { schema: 'z0-seed-rule/1', settings, inputs: hashes, ...result };
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
  return { code: 0, stdout: `${summary(report)}\n`, stderr: '' };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
