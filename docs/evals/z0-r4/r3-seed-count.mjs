// Read-only: the seed count each round 4 test's seed rule gives on round 3's records (seeds 1-3, four families dropped), for the prereg's budget check.
// Usage: node docs/evals/z0-r4/r3-seed-count.mjs --analyzer <checkout of 04835462b> [--report FILE] [--grading FILE] [--drop-list FILE]
import { openRound3 } from './r3-open.mjs';

const { inputs, load, scoredNoDrop } = await openRound3(['scripts/token-eval/z0-hypotheses.mjs', 'scripts/token-eval/z0-size-sim.mjs', 'scripts/token-eval/z0-seed-rule.mjs', 'dist/eval/repository-t.js']);
const { repeatMistakeUnits, firstApplyR, CODINGS } = await load('scripts/token-eval/z0-hypotheses.mjs');
const { seedsNeeded } = await load('scripts/token-eval/z0-size-sim.mjs');
const { pooledComponents } = await load('dist/eval/repository-t.js');
const { parseArgs, seedRule } = await load('scripts/token-eval/z0-seed-rule.mjs');
const DROP = new Set(['hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1']);
const CAP = 9;
const s = scoredNoDrop().filter((r) => r.seed <= 3);
const counts = [];
for (const [test, t, c] of [['T1', 'A2', 'A1'], ['T3', 'A2', 'A5']]) {
  for (const coding of CODINGS) {
    const units = repeatMistakeUnits(s, t, c, coding, firstApplyR).units.filter((u) => !DROP.has(u.family));
    const k = seedsNeeded(units, 0.15, { cap: CAP, targetZ: 3.5 });
    counts.push(k ?? CAP);
    console.log(`${test} ${t}/${c} ${coding}: units ${units.length} repos ${pooledComponents(units).repos.length} seeds ${k ?? `over ${CAP}`}`);
  }
}
// parseArgs only supplies the analyzer's own defaults; its three file arguments are placeholders it never opens.
const opts = { ...parseArgs(['--runs', '-', '--plan', '-', '--prices', '-']), dropList: inputs.dropList };
// H4 is last: its harm sizer simulates at every seed count from 3 up and can run for minutes.
const h4 = seedRule(inputs.records, inputs.planCells, inputs.prices, opts).perHypothesis.H4;
counts.push(h4 ?? opts.cap);
console.log(`H4 harmSeeds: seeds ${h4 ?? `over ${opts.cap}`}`);
console.log(`largest: ${Math.max(...counts)} seeds (T1, T3, H4; parts (a) and (b) give 3 on A2/A1 in r3-parta-se.mjs)`);
