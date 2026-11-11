#!/usr/bin/env node
/** Z0 Amendment 2 item 5, the blind seed rule: how many seeds the rule arms run after wave 1. It reads wave 1 only (seeds 1 to 3)
 * and prints seed counts, never a mean, estimate, sign or spread, so it cannot see the effect. Exit 0 on a result (a stop too), 1 on bad input.
 * A cap miss runs that hypothesis at the cap, or with --on-miss stop stops the run. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pooledComponents } from '../../dist/eval/repository-t.js';
import { ARM_TABLE, DESIGNS, designByName, designName, isRound4Design, pairOf } from './arms.mjs';
import { loadInputs } from './z0-analyze.mjs';
import { inputHashes } from './z0-blind.mjs';
import { filterOpts, filteredInput } from './z0-filters.mjs';
import { CODINGS, codexApply, firstApplyR, repeatMistakeUnits } from './z0-hypotheses.mjs';
import { SEED_CAP, SEED_RULE_SCHEMA, SEED_RULE_SCHEMA_R3, isString } from './z0-records.mjs';
import { HARM_TEST, expandReadSet, extraRows } from './z0-size.mjs';
import { R4_SEED, checkLevelFlags, harmSeeds, isRoundFour, levelsFor, readLevelFiles, seedRuleR4 } from './z0-size-r4.mjs';
import { SEEDS, TARGET_Z, seedsNeeded } from './z0-size-sim.mjs';

const DEFAULTS = { minimumEffect: 0.15, targetZ: TARGET_Z, cap: SEED_CAP, onMiss: 'cap', power: 0.8, sims: 2_000, seed: 1, bound: 0.8 };
const STOP_NOTE = 'the run stops after wave 1 and scores nothing; size the next run with z0-size.mjs on these records as calibration (prereg line 215)';
const USAGE = 'usage: z0-seed-rule.mjs --runs FILE [--runs FILE ...] --plan FILE [--plan FILE ...] --prices FILE [--grading FILE] [--drop-list FILE] [--off-pin FILE ...] '
  + '[--minimum-effect 0.15] [--target-z 3.5] [--cap 9] [--on-miss stop|cap] [--power 0.8] [--sims 2000] [--seed 1] [--bound 0.8] [--out FILE]\n'
  + 'round 4: [--design r3|r4|r4-on-r3] [--read-set FILE] [--cost-ratio R] [--levels FILE ...]';

const number = (flag, ok, what) => (v) => {
  const n = Number(v);
  if (!ok(n)) throw new Error(`${flag} must be ${what}, got ${v}`);
  return n;
};
const integer = (flag, min) => number(flag, (n) => Number.isInteger(n) && n >= min, `an integer of at least ${min}`);
const fraction = (flag) => number(flag, (n) => n > 0 && n < 1, 'between 0 and 1');
const REPEATED = new Map([['--runs', 'runs'], ['--plan', 'plan'], ['--off-pin', 'offPin'], ['--levels', 'levels']]);
const ROUND_FOUR_FLAGS = new Set(['--read-set', '--cost-ratio', '--levels']);
const designArg = (v) => {
  designByName(v);
  return v;
};
const FLAGS = new Map([
  ['--prices', ['prices', String]], ['--grading', ['grading', String]], ['--drop-list', ['dropList', String]], ['--out', ['out', String]],
  ['--minimum-effect', ['minimumEffect', fraction('--minimum-effect')]],
  ['--target-z', ['targetZ', number('--target-z', (n) => Number.isFinite(n) && n > 0, 'a positive number')]],
  ['--cap', ['cap', integer('--cap', SEEDS)]], ['--power', ['power', fraction('--power')]],
  ['--on-miss', ['onMiss', (v) => {
    if (v !== 'stop' && v !== 'cap') throw new Error(`--on-miss must be stop or cap, got ${v}`);
    return v;
  }]],
  ['--sims', ['sims', integer('--sims', 1)]], ['--seed', ['seed', integer('--seed', 1)]], ['--bound', ['bound', fraction('--bound')]],
  ['--design', ['design', designArg]], ['--read-set', ['readSet', String]], ['--cost-ratio', ['costRatio', number('--cost-ratio', (n) => Number.isFinite(n) && n > 0, 'a positive number')]],
]);

/** Round 3 takes none of the round 4 flags; round 4 draws use one seed; `r4` needs the cost ratio and both levels files, `r4-on-r3` takes at most one. */
function checkRoundFour(args, given, used) {
  const design = designByName(args.design);
  if (!isRoundFour(design)) {
    if (used.length > 0) throw new Error(`${used[0]}: round 4 only`);
    return;
  }
  if (given.has('--seed')) throw new Error(`round 4 draws use seed ${R4_SEED} (prereg item 10)`);
  if (isRound4Design(design) && args.costRatio === null) throw new Error('--cost-ratio is required under round 4');
  checkLevelFlags(args.design, args.levels.length, true);
}

/** @param {string[]} argv @returns {any} */
export function parseArgs(argv) {
  const args = { runs: [], plan: [], offPin: [], levels: [], mergeManifest: [], prices: null, dropList: null, grading: null, out: null, design: 'r3', readSet: null, costRatio: null, help: false, ...DEFAULTS };
  const [given, used] = [new Set(), []];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...args, help: true };
    const value = argv[++i];
    if (!isString(value) || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (ROUND_FOUR_FLAGS.has(flag)) used.push(flag);
    if (REPEATED.has(flag)) args[REPEATED.get(flag)].push(value);
    else if (!FLAGS.has(flag)) throw new Error(`unknown flag ${flag}\n${USAGE}`);
    else if (given.has(flag)) throw new Error(`${flag} given twice`);
    else {
      const [key, parse] = FLAGS.get(flag);
      args[key] = parse(value);
      given.add(flag);
    }
  }
  if ((args.readSet === null && (args.runs.length === 0 || args.plan.length === 0)) || args.prices === null) throw new Error(USAGE);
  checkRoundFour(args, given, used);
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

/** The seeds per rule arm from wave-1 records alone. Abandoned runs are left out, as in the sizer. A round 4 design takes its per-test rules from `seedRuleR4`.
 * @param {any[]} records @param {any[]} planCells @param {any} prices @param {any} opts @returns {any} */
export function seedRule(records, planCells, prices, opts) {
  const design = opts.design ?? DESIGNS.r3;
  if (isRoundFour(design)) return seedRuleR4(records, planCells, prices, opts);
  const { filtered } = filteredInput(records, planCells, opts, { dropAbandoned: true });
  if (filtered.scored.some((r) => r.seed > SEEDS)) throw new Error(`the rule reads wave 1 only: a scored record has a seed above ${SEEDS}`);
  // The first group is the primary family and always runs; a later group runs only when all its arms are planned.
  const groups = design.seedRule.filter((g, i) => i === 0 || g.arms.every((a) => filtered.arms.includes(a)));
  const named = groups.flatMap((g) => g.tests);
  if (named.length === 0) throw new Error(`design ${designName(design)} names no test in its seed rule, so the rule has nothing to size`);
  const repeat = (name) => {
    const pair = pairOf(design, name);
    return repeatSeeds(name, filtered.scored, pair, ARM_TABLE[pair[0]].tool === 'codex' ? codexApply : firstApplyR, opts);
  };
  const perHypothesis = Object.fromEntries(named.sort().map((name) => [name, name === HARM_TEST ? harmSeeds(filtered, prices, opts) : repeat(name)]));
  const short = Object.entries(perHypothesis).filter(([, n]) => n === null).map(([h]) => `${h} needs more than ${opts.cap} seeds`);
  if (short.length > 0 && opts.onMiss !== 'cap') return { seeds: null, perHypothesis, stop: true, reasons: [...short, STOP_NOTE] };
  const at = (n) => n ?? opts.cap;
  const seeds = Object.fromEntries(groups.flatMap((g) => g.arms.map((a) => [a, Math.max(...g.tests.map((t) => at(perHypothesis[t])))])));
  return { seeds, perHypothesis, stop: false, reasons: short.map((s) => `${s}, so it runs at the cap`) };
}

function summary(r) {
  if (r.stop) return `stop: ${r.reasons.join('; ')}`;
  const seeds = `seeds ${Object.entries(r.seeds).map(([arm, n]) => `${arm} ${n}`).join(', ')}`;
  return r.reasons.length === 0 ? seeds : `${seeds}; ${r.reasons.join('; ')}`;
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  const fail = (message) => ({ code: 1, stdout: '', stderr: `${message}\n` });
  let report;
  let args;
  const notes = [];
  try {
    args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    if (args.readSet !== null) expandReadSet(args, cwd);
    const inputs = loadInputs(args, cwd);
    const round4 = isRoundFour(inputs.design);
    const settings = { ...Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, args[k]])), firstWave: SEEDS, design: args.design, costRatio: args.costRatio };
    const shown = round4 ? { ...settings, seed: R4_SEED, levels: args.levels } : settings;
    const levels = round4 ? levelsFor(inputs.design, readLevelFiles(args.levels, cwd), (m) => notes.push(m)) : null;
    const opts = { ...settings, ...filterOpts(inputs) };
    if (round4) Object.assign(opts, { seed: R4_SEED, levels });
    const result = seedRule(inputs.records, inputs.planCells, inputs.prices, opts);
    const hashes = inputHashes(args, cwd, { entry: 'scripts/token-eval/z0-seed-rule.mjs', extra: extraRows(args) });
    report = { schema: round4 ? SEED_RULE_SCHEMA : SEED_RULE_SCHEMA_R3, settings: shown, inputs: hashes, ...result };
  } catch (e) {
    return fail(e.message);
  }
  const stderr = notes.map((n) => `${n}\n`).join('');
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out === null) return { code: 0, stdout: json, stderr };
  try {
    fs.writeFileSync(path.resolve(cwd, args.out), json);
  } catch (e) {
    return fail(`--out ${args.out}: ${e.message}`);
  }
  return { code: 0, stdout: `${summary(report)}\n`, stderr };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
