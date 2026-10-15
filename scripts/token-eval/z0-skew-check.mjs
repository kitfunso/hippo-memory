#!/usr/bin/env node
/** Z0 H4 skew check (Amendment 1): at a true cost ratio of 1.10 the cost gate's "upper 95% bound" (prereg 143) should pass
 * at most 5% of runs. Simulates set N with the sizer's seeded harm simulator and prints each cell's pass shares for the Cox
 * interval the gate uses and the cluster-robust t interval. Exit 0 when every cell holds, 1 when one does not. */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { harmGate, seededRandom } from '../../dist/eval/eval-stats.js';
import { clusterRatioT } from '../../dist/eval/repository-t.js';
import { blocks, harmT, sum } from './z0-hypotheses.mjs';
import { cellSeed, harmRun } from './z0-size-sim.mjs';

const LIMIT = 1.1;
// The gate reads the upper end of a two-sided 95% interval, aiming at 2.5%; the prereg's one-sided 95% bound allows 5%.
const BAR = 0.05;
const TASKS = 26;
const USAGE = 'usage: z0-skew-check.mjs [--runs 20000] [--seed 1]';
const resolve = { both: 0.6, oneSide: 0.1 };
const s9 = { ...resolve, repo: 0.0225, family: 0.05, seed: 0.1, controlSd: 0.8 };
// Only the repository SD of 0.15 is measured (S9); the harsher and wider rows bracket the assumed spreads,
// and the near-normal row shows the interval holds its level when the t test's assumptions do.
export const CELLS = [5, 10].flatMap((repos) => [
  { name: 'S9 spreads', repos, cal: s9 },
  { name: 'harsher family, seed and control', repos, cal: { ...s9, family: 0.1, seed: 0.2, controlSd: 1.2 } },
  { name: 'repository SD 0.30', repos, cal: { ...s9, repo: 0.09 } },
]).concat([{ name: 'near normal, repository SD 0.01', repos: 5, cal: { ...resolve, repo: 0.0001, family: 0, seed: 0, controlSd: 0 } }]);

/** Shares of `runs` seeded runs at a true ratio of 1.10 whose cost gate, and whole gate, pass under each interval. */
export function skewCell(cell, runs, seed) {
  const rand = seededRandom(cellSeed(seed, 'H4 skew', cell.name, cell.repos));
  const n = { cox: 0, coxGate: 0, clusterRobust: 0, clusterRobustGate: 0 };
  for (let i = 0; i < runs; i++) {
    const units = harmRun(cell.cal, { repos: cell.repos, tasks: TASKS }, rand, LIMIT);
    const h = harmT(units, {});
    const sums = blocks(units).map((fams) => ({ t: sum(fams.flat().map((u) => u.t.cost)), c: sum(fams.flat().map((u) => u.c.cost)) }));
    const cr = harmGate(clusterRatioT(sums), h.resolveDiff);
    n.cox += Number(h.gate.costOk);
    n.coxGate += Number(h.gate.pass);
    n.clusterRobust += Number(cr.costOk);
    n.clusterRobustGate += Number(cr.pass);
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
  const lines = [`true cost ratio ${LIMIT}, ${TASKS} set N tasks per repository, ${opts.runs} runs per cell, seed ${opts.seed}; `
    + `bar ${pct(BAR)}, failing above ${pct(ceiling)}`];
  let held = true;
  for (const cell of CELLS) {
    const s = skewCell(cell, opts.runs, opts.seed);
    held &&= s.cox <= ceiling;
    lines.push(`${s.cox <= ceiling ? 'hold' : 'FAIL'} ${cell.name}, ${cell.repos} repositories: cost gate passes Cox ${pct(s.cox)}, `
      + `cluster-robust ${pct(s.clusterRobust)}; whole gate Cox ${pct(s.coxGate)}, cluster-robust ${pct(s.clusterRobustGate)}`);
  }
  return { code: held ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
