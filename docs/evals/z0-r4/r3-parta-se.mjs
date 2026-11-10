// Read-only: round 3 sets R+N, seeds 1-3. Part (a)'s v cells and part (b)'s resolve cells; the seed count each rule gives.
// Usage: node docs/evals/z0-r4/r3-parta-se.mjs --analyzer <checkout of 04835462b> [--report FILE] [--grading FILE] [--drop-list FILE]
import { openRound3 } from './r3-open.mjs';

const { api, prices, load, scoredNoDrop } = await openRound3(['scripts/token-eval/z0-size-sim.mjs', 'dist/eval/repository-t.js']);
const { seedsNeeded, spreadComponents } = await load('scripts/token-eval/z0-size-sim.mjs');
const { pooledComponents } = await load('dist/eval/repository-t.js');
const s = scoredNoDrop().filter((r) => r.seed <= 3);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const CAP = 9;
// Item 10's fixed m for part (a).
const M_A = Math.log(1 / 0.9);
for (const [t, c] of [['A2', 'A1'], ['A0', 'A1'], ['A4', 'A1']]) {
  const u = api.taskUnits(s, t, c, prices, api.inSets('R', 'N'));
  const g = new Map();
  for (const x of u) { const k = JSON.stringify([x.repo, x.family, x.seed]); g.set(k, [...(g.get(k) ?? []), x]); }
  const cells = [...g.values()].map((us) => ({ repo: us[0].repo, family: us[0].family, seed: us[0].seed,
    Ct: sum(us.map((x) => x.t.cost)), Cc: sum(us.map((x) => x.c.cost)), St: sum(us.map((x) => x.t.resolved)), Sc: sum(us.map((x) => x.c.resolved)), n: us.length }));
  const m = (f) => sum(cells.map(f)) / cells.length;
  const [mCt, mCc, mSt, mSc] = [m((x) => x.Ct), m((x) => x.Cc), m((x) => x.St), m((x) => x.Sc)];
  const v = cells.map((x) => ({ repo: x.repo, family: x.family, seed: x.seed, value: x.Ct / mCt - x.Cc / mCc - x.St / mSt + x.Sc / mSc }));
  const b = cells.map((x) => ({ repo: x.repo, family: x.family, seed: x.seed, value: (x.St - x.Sc) / x.n }));
  const R = (sum(cells.map((x) => x.Ct)) * sum(cells.map((x) => x.Sc))) / (sum(cells.map((x) => x.Cc)) * sum(cells.map((x) => x.St)));
  const out = { pair: `${t}/${c}`, cells: cells.length, R: +R.toFixed(4) };
  for (const [name, units, ms] of [['a', v, [M_A, Math.log(2), Math.log(2 / 1.5), Math.log(2 / 1.8)]], ['b', b, [0.03]]]) {
    const sc = spreadComponents(units, 0.2);
    out[name] = { fam: +sc.family.toFixed(5), seq: +sc.sequence.toFixed(5), noise: +sc.noise.toFixed(5),
      seeds: ms.map((mm) => [+mm.toFixed(3), seedsNeeded(units, mm, { cap: CAP, targetZ: 3.08 })]),
      seedsUpper: ms.map((mm) => [+mm.toFixed(3), seedsNeeded(units.map((x) => x), mm, { cap: 50, targetZ: 3.08 })]) };
  }
  const p = pooledComponents(v); const fam = Math.max(0, (p.F - p.E) / p.sBar), seq = Math.max(0, (p.Q - p.E) / p.kBar), noi = p.E;
  const se = (n) => Math.sqrt(p.repos.reduce((a, r) => a + fam / r.k + seq / n + noi / (r.k * n), 0) / p.repos.length ** 2);
  out.aSE = [3, 4, 9, 50].map((n) => [n, +se(n).toFixed(4)]); out.bar = +(M_A / 3.08).toFixed(4); out.G = p.repos.length; out.meanK = +(p.repos.reduce((a, r) => a + r.k, 0) / p.repos.length).toFixed(2);
  console.log(JSON.stringify(out));
  // Part (a)'s miss branch (prereg item 10): the fewest seeds from 3 to the cap whose predicted SE is within 1.1 times the cap's.
  const [limit, hit] = [1.1 * se(CAP), out.a.seeds[0][1]];
  const pick = Array.from({ length: CAP - 2 }, (_, i) => i + 3).find((n) => se(n) <= limit);
  console.log(hit === null
    ? `${t}/${c} miss branch: ${pick} seeds (${se(pick).toFixed(4)} <= 1.1 x ${se(CAP).toFixed(4)} = ${limit.toFixed(4)}); the cap gives ${CAP}`
    : `${t}/${c} no miss at m ${M_A.toFixed(5)}: the rule gives ${hit} seeds`);
}
