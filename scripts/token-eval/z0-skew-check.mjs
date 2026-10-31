#!/usr/bin/env node
/** Z0 H4 skew check (Amendment 2): at a true cost ratio of 1.10 the cost gate's "upper 95% bound" (prereg 143) should pass
 * at most 5% of runs. Simulates set N with the sizer's seeded harm simulator and prints each cell's pass shares for the log
 * interval the gate uses and for a symmetric one. Exit 0 when every cell's log interval holds, 1 when one does not. */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { harmGate, seededRandom } from '../../dist/eval/eval-stats.js';
import { studentTQuantile } from '../../dist/eval/repository-t.js';
import { harmT } from './z0-hypotheses.mjs';
import { SEEDS, cellSeed, harmRun } from './z0-size-sim.mjs';

const LIMIT = 1.1;
// The gate reads the upper end of a two-sided 95% interval, aiming at 2.5%; the prereg's one-sided 95% bound allows 5%.
const BAR = 0.05;
const TASKS = 26;
const USAGE = 'usage: z0-skew-check.mjs [--runs 20000] [--seed 1]';
const resolve = { both: 0.6, oneSide: 0.1 };
// The spreads are assumed, not measured; the harsher and sequence-heavy rows bracket them, and the near-normal row shows the
// interval holds its level when the t test's assumptions do.
export const CELLS = [5, 10].flatMap((repos) => [
  { name: 'calibration-like', repos, cal: { ...resolve, family: 0.05, sequence: 0.05, noise: 0.1, controlSd: 0.8 } },
  { name: 'harsher', repos, cal: { ...resolve, family: 0.1, sequence: 0.1, noise: 0.2, controlSd: 1.2 } },
  { name: 'sequence-heavy', repos, cal: { ...resolve, family: 0.02, sequence: 0.2, noise: 0.05, controlSd: 0.8 } },
]).concat([{ name: 'near normal', repos: 5, cal: { ...resolve, family: 0, sequence: 0, noise: 0.0001, controlSd: 0 } }]);

// The same interval as the gate's, made symmetric: R (1 + q se) with se on the log scale, to show what skew costs.
function symmetric(h) {
  const { estimate, se, df } = h.costRatio;
  if (!Number.isFinite(se) || !Number.isFinite(df)) return { costOk: false, pass: false };
  return harmGate({ ...h.costRatio, high: estimate * (1 + studentTQuantile(0.975, df) * se) }, h.resolveDiff);
}

/** Shares of `runs` seeded runs at a true ratio of 1.10 whose cost gate, and whole gate, pass under each interval. */
export function skewCell(cell, runs, seed) {
  const rand = seededRandom(cellSeed(seed, 'H4 skew', cell.name, cell.repos));
  const n = { costLog: 0, costSymmetric: 0, gateLog: 0, gateSymmetric: 0 };
  for (let i = 0; i < runs; i++) {
    const h = harmT(harmRun(cell.cal, { repos: cell.repos, tasks: TASKS, seeds: SEEDS }, rand, LIMIT), {});
    const sym = symmetric(h);
    n.costLog += Number(h.gate.costOk);
    n.gateLog += Number(h.gate.pass);
    n.costSymmetric += Number(sym.costOk);
    n.gateSymmetric += Number(sym.pass);
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v / runs]));
}

/** @param {string[]} argv */
export function runCli(argv) {
  const opts = { runs: 20_000, seed: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], Number(argv[i + 1])];
    if (!['--runs', '--seed'].includes(flag) || !Number.isInteger(value) || value < 1) return { code: 1, stdout: '', stderr: `${USAGE}\n` };
    opts[flag.slice(2)] = value;
  }
  const pct = (x) => `${(100 * x).toFixed(2)}%`;
  // A gate exactly at its level lands above the bar in half the runs, so a cell fails only 2 simulation errors above it.
  const ceiling = BAR + 2 * Math.sqrt((BAR * (1 - BAR)) / opts.runs);
  const lines = [`true cost ratio ${LIMIT}, ${TASKS} set N tasks per repository, ${SEEDS} seeds, ${opts.runs} runs per cell, seed ${opts.seed}; `
    + `bar ${pct(BAR)}, failing above ${pct(ceiling)}`];
  let held = true;
  for (const cell of CELLS) {
    const s = skewCell(cell, opts.runs, opts.seed);
    held &&= s.costLog <= ceiling;
    lines.push(`${s.costLog <= ceiling ? 'hold' : 'FAIL'} ${cell.name}, ${cell.repos} repositories: cost gate passes log ${pct(s.costLog)}, `
      + `symmetric ${pct(s.costSymmetric)}; whole gate log ${pct(s.gateLog)}, symmetric ${pct(s.gateSymmetric)}`);
  }
  return { code: held ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
