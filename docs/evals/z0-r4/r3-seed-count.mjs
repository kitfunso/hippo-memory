// Read-only: the seed count each round 4 test's seed rule gives (T1, T3, T2 parts (a) and (b), H4) on round 3's records (seeds 1-3, four families dropped), for the prereg's budget check.
// Usage: node docs/evals/z0-r4/r3-seed-count.mjs --analyzer <checkout of 04835462b> [--report FILE] [--grading FILE] [--drop-list FILE]
import { openRound3 } from './r3-open.mjs';

const { api, prices, inputs, load, scoredNoDrop } = await openRound3(['scripts/token-eval/z0-hypotheses.mjs', 'scripts/token-eval/z0-size-sim.mjs', 'scripts/token-eval/z0-seed-rule.mjs', 'dist/eval/repository-t.js']);
const { repeatMistakeUnits, firstApplyR, CODINGS } = await load('scripts/token-eval/z0-hypotheses.mjs');
const { seedsNeeded, spreadComponents, SEEDS } = await load('scripts/token-eval/z0-size-sim.mjs');
const { pooledComponents } = await load('dist/eval/repository-t.js');
const { parseArgs, seedRule } = await load('scripts/token-eval/z0-seed-rule.mjs');
const DROP = new Set(['hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1']);
const CAP = 9;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// seedsNeeded keeps its variance private, so its formula is repeated here and a count that disagrees with it throws.
function sized(units, m, z) {
  const { repos } = pooledComponents(units);
  const { family, sequence, noise } = spreadComponents(units, 0.2);
  const se = (n) => Math.sqrt(sum(repos.map((r) => family / r.k + sequence / n + noise / (r.k * n))) / repos.length ** 2);
  const k = seedsNeeded(units, m, { cap: CAP, targetZ: z });
  const n = k ?? CAP;
  const bar = m / z;
  if ((se(n) <= bar) !== (k !== null) || (n > SEEDS && se(n - 1) <= bar)) throw new Error(`predicted SE disagrees with seedsNeeded's ${k} seeds`);
  return { se, bar, barName: 'bar', k, n, repos: repos.length };
}
// The rule starts at SEEDS, so there is no one-fewer figure at 3.
const fmt = ({ se, bar, barName, n }) => `se(${n}) ${se(n).toFixed(5)}${n > SEEDS ? ` se(${n - 1}) ${se(n - 1).toFixed(5)}` : ''} ${barName} ${bar.toFixed(5)}`;
const s = scoredNoDrop().filter((r) => r.seed <= 3);
const counts = [];
for (const [test, t, c] of [['T1', 'A2', 'A1'], ['T3', 'A2', 'A5']]) {
  for (const coding of CODINGS) {
    const units = repeatMistakeUnits(s, t, c, coding, firstApplyR).units.filter((u) => !DROP.has(u.family));
    const r = sized(units, 0.15, 3.5);
    counts.push(r.n);
    console.log(`${test} ${t}/${c} ${coding}: units ${units.length} repos ${r.repos} ${fmt(r)} seeds ${r.k ?? `over ${CAP}`}`);
  }
}
// T2's cells, v and b are r3-parta-se.mjs's for A2/A1 on sets R+N; the drop comes before the cells so the four families leave every cell.
const g = new Map();
for (const x of api.taskUnits(s, 'A2', 'A1', prices, api.inSets('R', 'N')).filter((u) => !DROP.has(u.family))) {
  const k = JSON.stringify([x.repo, x.family, x.seed]);
  g.set(k, [...(g.get(k) ?? []), x]);
}
const cells = [...g.values()].map((us) => ({ repo: us[0].repo, family: us[0].family, seed: us[0].seed,
  Ct: sum(us.map((x) => x.t.cost)), Cc: sum(us.map((x) => x.c.cost)), St: sum(us.map((x) => x.t.resolved)), Sc: sum(us.map((x) => x.c.resolved)), n: us.length }));
const m = (f) => sum(cells.map(f)) / cells.length;
const [mCt, mCc, mSt, mSc] = [m((x) => x.Ct), m((x) => x.Cc), m((x) => x.St), m((x) => x.Sc)];
const v = cells.map((x) => ({ repo: x.repo, family: x.family, seed: x.seed, value: x.Ct / mCt - x.Cc / mCc - x.St / mSt + x.Sc / mSc }));
const b = cells.map((x) => ({ repo: x.repo, family: x.family, seed: x.seed, value: (x.St - x.Sc) / x.n }));
// Part (a) at m 0.105, the smallest of r3-parta-se's four m and so its largest count; on a miss, the fewest seeds from 3 to the cap within 1.1 times the cap's SE (prereg item 10).
let a = sized(v, 0.105, 3.08);
if (a.k === null) {
  const limit = 1.1 * a.se(CAP);
  a = { ...a, bar: limit, barName: 'miss limit 1.1 x se(9)', n: Array.from({ length: CAP - SEEDS + 1 }, (_, i) => i + SEEDS).find((n) => a.se(n) <= limit) };
}
console.log(`T2 part (a) A2/A1: cells ${cells.length} repos ${a.repos} m 0.105 ${fmt(a)} seeds ${a.n}`);
const pb = sized(b, 0.03, 3.08);
console.log(`T2 part (b) A2/A1: cells ${cells.length} repos ${pb.repos} m 0.03 ${fmt(pb)} seeds ${pb.k ?? `over ${CAP}`}`);
counts.push(a.n, pb.n);
// Round 3's drop list is empty, so the four families are added to the list the rule's filterRecords reads and H4 sees the same read as T1, T3 and T2.
const dropList = { ...inputs.dropList, droppedFamilies: [...(inputs.dropList?.droppedFamilies ?? []), ...DROP] };
// parseArgs only supplies the analyzer's own defaults; its three file arguments are placeholders it never opens.
const opts = { ...parseArgs(['--runs', '-', '--plan', '-', '--prices', '-']), dropList };
// H4 is last: its harm sizer simulates at every seed count from 3 up and can run for minutes.
const h4 = seedRule(inputs.records, inputs.planCells, inputs.prices, opts).perHypothesis.H4;
counts.push(h4 ?? opts.cap);
console.log(`H4 harmSeeds (four families dropped): seeds ${h4 ?? `over ${opts.cap}`}`);
console.log(`largest: ${Math.max(...counts)} seeds (T1, T3, T2 parts (a) and (b), H4)`);
