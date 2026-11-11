/** Z0 analyzer, round 4 path: the read set, the seed windows, the closed-test scores, the headline and the checks of the round 4 input files.
 * z0-analyze.mjs reads the files and prints; nothing here touches a file but the read set. */

import * as path from 'node:path';

import { ARM_TABLE, DESIGNS, designName, pairOf } from './arms.mjs';
import { CODINGS } from './z0-hypotheses.mjs';
import { keysOf, readReadSet } from './z0-read-set.mjs';
import { LEVELS_SCHEMA, SEED_CAP, SEED_RULE_SCHEMA } from './z0-records.mjs';
import { NO_VERDICT, THRESHOLDS, T_NULLS, closedTest, minLevels, scoreTest } from './z0-verdict-r4.mjs';

const PARTS = ['a', 'b', 'c'];
const BRANCHES = ['rule', 'miss', 'cap'];
const isPlain = (v) => v !== undefined && v !== null && v.constructor === Object;

/** The args with the read set's pairs written out: each full pair's runs, plan and off-pin file, each merge manifest, and the `--max-seed` line (null without one). */
export function expandReadSet(args, cwd) {
  if (args.readSet === null) return args;
  const { maxSeed, pairs } = readReadSet(path.resolve(cwd, args.readSet));
  const of = (field) => pairs.map((p) => p[field]).filter((v) => v !== null);
  const out = { ...args, runs: [...args.runs, ...of('runs')], plan: [...args.plan, ...of('plan')], offPin: [...args.offPin, ...of('offPin')], mergeManifest: [...args.mergeManifest, ...of('mergeManifest')], maxSeed };
  if (out.runs.length === 0) throw new Error(`${args.readSet}: the read set names no runs file; add a line with --runs, --plan and --off-pin`);
  return out;
}

/** The levels files through `minLevels`, the first as the pre-freeze file and the second as batch 1; its log lines come back as `notes`. */
export function levelsOf(files, parsed) {
  const notes = [];
  const given = parsed.map((body, i) => {
    if (!isPlain(body)) throw new Error(`${files[i]}: a levels file is a JSON object`);
    if (body.schema !== LEVELS_SCHEMA) throw new Error(`${files[i]}: schema must be "${LEVELS_SCHEMA}"`);
    return { ...body, file: files[i] };
  });
  try {
    return { levels: minLevels(given[0], given[1], (line) => notes.push(line)), notes };
  } catch (e) {
    throw new Error(`${files.join(' and ')}: ${e.message}`);
  }
}

/** The /2 seed rule's per-test counts, checked: a count from 3 to the seed cap, a branch, and a power for a miss or cap branch. */
export function checkSeedRule(rule, file) {
  if (!isPlain(rule)) throw new Error(`${file}: a seed rule is a JSON object`);
  if (rule.schema !== SEED_RULE_SCHEMA) throw new Error(`${file}: schema must be "${SEED_RULE_SCHEMA}"`);
  if (rule.design !== 'r4') throw new Error(`${file}: design must be "r4"`);
  for (const test of DESIGNS.r4.seedRule[0].tests) {
    const t = rule.perTest?.[test];
    if (!isPlain(t)) throw new Error(`${file}: perTest has no entry for ${test}`);
    if (!Number.isInteger(t.seeds) || t.seeds < 3 || t.seeds > SEED_CAP) throw new Error(`${file}: perTest.${test}.seeds must be an integer from 3 to ${SEED_CAP}`);
    if (!BRANCHES.includes(t.branch)) throw new Error(`${file}: perTest.${test}.branch must be one of ${BRANCHES.join(', ')}`);
    if (t.branch !== 'rule' && !Number.isFinite(t.power)) throw new Error(`${file}: perTest.${test}.power must be a number on the ${t.branch} branch`);
  }
  return rule;
}

/** The repository keys of the frozen layout: batch 1's, then batch 2's. */
export function batchKeysOf(pins, file) {
  if (!isPlain(pins)) throw new Error(`${file}: a pins file is a JSON object`);
  return [...keysOf(pins, 'batch1Keys', file), ...keysOf(pins, 'batch2Keys', file)];
}

/** Per test of the seed rule: its count `n`, `k` (the highest seed every key has planned for both arms of the test's pair, every seed from 1), whether
 * `k` reaches `n`, and the branch and power. Read from the plan cells the seed cap left. */
export function seedWindows(planCells, design, seedRule, batchKeys) {
  const planned = new Set(planCells.map((c) => JSON.stringify([c.sequence, c.arm, c.seed])));
  const has = (key, arm, seed) => planned.has(JSON.stringify([key, arm, seed]));
  return Object.fromEntries(design.seedRule[0].tests.map((test) => {
    const { seeds, branch, power } = seedRule.perTest[test];
    const pair = pairOf(design, test);
    let k = 0;
    while (k < SEED_CAP && batchKeys.every((key) => pair.every((arm) => has(key, arm, k + 1)))) k += 1;
    return [test, { n: seeds, k, reached: k >= seeds, branch, power }];
  }));
}

const levelAt = (levels, test, threshold) => levels[test][threshold].level ?? levels[test][threshold];
const usable = (e) => e !== null && e !== undefined && Number.isFinite(e.estimate) && Number.isFinite(e.se);

/** One estimate scored at each threshold its test reads: p, the bounds and the win at each, and the knife edge. */
function scoredOne(name, e, levels) {
  const { nullValue, side } = T_NULLS[name];
  const at = Object.fromEntries(THRESHOLDS[name].map((t) => [t, scoreTest(e, { nullValue, side, level: levelAt(levels, name, t) })]));
  const first = at[THRESHOLDS[name][0]];
  const pick = (field) => Object.fromEntries(Object.entries(at).map(([t, s]) => [t, s[field]]));
  const bounds = Object.fromEntries(Object.entries(at).map(([t, s]) => [t, { low: s.low, high: s.high }]));
  return { estimate: e.estimate, se: e.se, df: e.df, side, p: first.p, bounds, win: pick('win'), edge: pick('edge') };
}

/** A test's `closedTest` input: null when it has no usable estimate, `codings` for one that holds a result per coding. */
function viewOf(name, e, levels) {
  if (e === null || e === undefined) return null;
  if (!Object.hasOwn(e, 'violation')) return usable(e) ? scoredOne(name, e, levels) : null;
  if (!CODINGS.every((c) => usable(e[c]))) return null;
  return { codings: Object.fromEntries(CODINGS.map((c) => [c, scoredOne(name, e[c], levels)])) };
}

const eachView = (v) => (v === null || v.codings === undefined ? [v].filter(Boolean) : Object.values(v.codings));
const edgeOf = (v, threshold) => eachView(v).some((x) => x.edge[threshold]);

/** S1 against O1: every part scored at the level of the same T2 part at `threshold`; it passes when every part (both codings of part c) wins there. */
function readS1(s1, levels, windows, threshold) {
  const parts = Object.fromEntries(PARTS.map((k) => [k, windows[`T2${k}`].reached ? viewOf(`T2${k}`, s1?.[k], levels) : null]));
  if (PARTS.some((k) => parts[k] === null)) return { verdict: NO_VERDICT, threshold, parts };
  const wins = PARTS.every((k) => eachView(parts[k]).every((v) => v.win[threshold]));
  return { verdict: wins ? 'pass' : 'no pass', threshold, parts };
}

/** The closed test over hand-made or measured estimates: `closed` is `closedTest`'s result, `views` its input, `edges` the wins a rounded-df bound contradicts,
 * and `s1` the exploratory S1 read. A test the run did not reach (`windows[test].reached` false) enters as null. */
export function scoreR4(estimates, levels, windows) {
  const reached = (test, e) => (windows[test].reached ? viewOf(test, e, levels) : null);
  const views = { T1: reached('T1', estimates.T1), T3: reached('T3', estimates.T3), T2: Object.fromEntries(PARTS.map((k) => [k, reached(`T2${k}`, estimates[`T2${k}`])])) };
  const closed = closedTest(views, levels);
  const read = closed.T2.readAt;
  const edges = {
    T1: closed.T1.verdict === 'win' && edgeOf(views.T1, '0.05'),
    T2: closed.T2.verdict === 'pass' && PARTS.some((k) => edgeOf(views.T2[k], read)),
    T3: closed.T3.verdict === 'win' && edgeOf(views.T3, read),
  };
  return { closed, views, edges, s1: readS1(estimates.s1, levels, windows, read ?? '0.025') };
}

/** The one effort every arm row of the design runs; a headline names one. */
export function effortOf(design) {
  const efforts = [...new Set(design.arms.map((a) => ARM_TABLE[a].effort))];
  if (efforts.length !== 1) throw new Error(`design ${designName(design)} rows hold efforts ${efforts.map(String).join(', ')}; a headline names one effort (prereg item 4)`);
  return efforts[0];
}

const one = (x) => x.toFixed(1);

/** The headline by item 4's branches. Added to the T2 sentence: the pooled task-level solve difference when below -0.03, and recorded spend per solve
 * when the T2 pair's treated arm is not below its control. `d` is the smaller of T1's two codings' cuts, so the line claims no more than both show. */
export function headlineR4({ design, scored, estimates, asOf, pooled, spendPerSolve }) {
  const effort = effortOf(design);
  const { closed } = scored;
  if (closed.T1.verdict !== 'win') return `At ${effort} effort, T1 is ${closed.T1.verdict}, so T2 and T3 get no verdict; their estimates follow and this run makes no cost claim.`;
  if (closed.T2.verdict !== 'pass') return `At ${effort} effort, hippo cuts Sonnet's repeat mistakes, but this run did not show that Sonnet with hippo meets the Opus bar.`;
  const cut = Math.min(...CODINGS.map((c) => -100 * estimates.T1[c].estimate));
  const main = `At ${effort} effort and at list prices on ${asOf}, Sonnet 5.5 with hippo solved these tasks at ${estimates.T2a.ratio.toFixed(2)} of the cost per solved task of Opus 5.5 with built-in memory. Its intervals ruled out more than 3 points fewer tasks solved and more than 15 points more first-apply repeats, and hippo cut Sonnet's first-apply repeats by ${one(cut)} points`;
  const [treat, base] = pairOf(design, 'T2a');
  const [own, opus] = [spendPerSolve[treat], spendPerSolve[base]];
  const added = [];
  if (pooled < -0.03) added.push(`counted per task, it solved ${one(-100 * pooled)} points fewer than Opus`);
  if (Number.isFinite(own) && Number.isFinite(opus) && own >= opus) added.push(`on the scored records; with discarded and rerun work, it cost ${(own / opus).toFixed(2)} of Opus per solved task`);
  return `${[main, ...added].join('; ')}.`;
}
