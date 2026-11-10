// Read-only: T1 (A2/A1 H1 spreads, real 28-repo layout, both codings) under the seed rule, null and effect -0.15, 20,000 draws.
// Prints size by level, per-coding power, the both-codings Frechet bound, and the level the prereg's z-SE bar and a point bar give.
// Usage: node docs/evals/z0-r4/r3-level25.mjs --analyzer <checkout of 04835462b> [--sims 20000] [--mode rule|fixed] [--levels 0.025,...,0.019] [--eff] [--report FILE] [--grading FILE] [--drop-list FILE]
import { arg, openRound3 } from './r3-open.mjs';

const { load, scoredNoDrop } = await openRound3(['scripts/token-eval/z0-hypotheses.mjs', 'scripts/token-eval/z0-size-sim.mjs', 'dist/eval/eval-stats.js']);
const { repeatT, repeatMistakeUnits, firstApplyR, CODINGS } = await load('scripts/token-eval/z0-hypotheses.mjs');
const { seedsNeeded, spreadComponents, normal, cellSeed } = await load('scripts/token-eval/z0-size-sim.mjs');
const { seededRandom } = await load('dist/eval/eval-stats.js');
const s = scoredNoDrop();
const DROP = new Set(['hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1']);
const lessons = s.filter((r) => (r.arm === 'A2' || r.arm === 'A1') && r.kind === 'apply' && firstApplyR(r)).flatMap((r) => r.lessons);
const na = lessons.filter((l) => l.first === 'na').length / lessons.length;
const cal = { point: {}, upper: {} }; let layout;
for (const coding of CODINGS) {
  const { units, dropped } = repeatMistakeUnits(s, 'A2', 'A1', coding, firstApplyR);
  const c = spreadComponents(units, 0.8);
  const base = { scale: coding === 'violation' ? 1 - na : 1, loss: dropped.length / (units.length + dropped.length) };
  cal.point[coding] = { ...base, family: c.family, sequence: c.sequence, noise: c.noise };
  cal.upper[coding] = { ...base, ...c.upper };
  if (coding === 'violation') { const m = new Map(); for (const u of units) if (!DROP.has(u.family)) (m.get(u.repo) ?? m.set(u.repo, new Set()).get(u.repo)).add(u.family); layout = [...m.values()].map((x) => x.size); }
}
const sd = Math.sqrt;
function run(c, rand, rule, delta, fixed) {
  const zf = layout.map((k) => Array.from({ length: k }, () => normal(rand)));
  const units = { violation: [], excluded: [] }; let seeds = 0;
  const addSeed = () => { seeds++; layout.forEach((k, r) => { const zq = normal(rand); for (let f = 0; f < k; f++) { const [ze, u] = [normal(rand), rand()]; for (const coding of CODINGS) { const q = c[coding]; if (u >= q.loss) units[coding].push({ repo: `r${r}`, family: `r${r}f${f}`, seed: seeds, value: q.scale * delta + sd(q.family) * zf[r][f] + sd(q.sequence) * zq + sd(q.noise) * ze }); } } }); };
  while (seeds < (fixed ?? 3)) addSeed();
  if (rule) { const need = CODINGS.map((k) => seedsNeeded(units[k], rule.m, rule)); const n = Math.max(...need.map((x) => x ?? rule.cap)); while (seeds < n) addSeed(); }
  return CODINGS.map((k) => { const t = repeatT(units[k], {}); return [t.p, t.estimate]; }).concat([[seeds]]);
}
const sims = Number(arg('--sims', 20000)), mode = arg('--mode', 'rule');
const rule = { m: 0.15, cap: 9, targetZ: 3.5 };
const levels = arg('--levels', '0.025,0.024,0.023,0.022,0.021,0.020,0.019').split(',').map(Number);
const zK = 3.54; const bar = (a, n) => a + zK * sd(a * (1 - a) / n);
const t0 = Date.now();
if (mode === 'rule') {
  for (const [name, c] of [['bounds', cal.upper], ['point', cal.point]]) {
    const nul = [], eff = [];
    let rand = seededRandom(cellSeed(20261110, 'r9', name, 'null'));
    for (let i = 0; i < sims; i++) nul.push(run(c, rand, rule, 0));
    if (process.argv.includes('--eff')) { rand = seededRandom(cellSeed(20261110, 'r9', name, 'eff')); for (let i = 0; i < sims; i++) eff.push(run(c, rand, rule, -0.15)); } else for (let i = 0; i < sims; i++) eff.push([[1, 0], [1, 0], [0]]);
    console.log(`T1 rule at ${name}: mean seeds null ${(nul.reduce((a, r) => a + r[2][0], 0) / sims).toFixed(2)} effect ${(eff.reduce((a, r) => a + r[2][0], 0) / sims).toFixed(2)}`);
    for (const a of levels) {
      const size = [0, 1].map((k) => nul.filter((r) => r[k][0] < a).length / sims);
      const pw = [0, 1].map((k) => eff.filter((r) => r[k][0] < a && r[k][1] < 0).length / sims);
      const joint = eff.filter((r) => r[0][0] < a && r[0][1] < 0 && r[1][0] < a && r[1][1] < 0).length / sims;
      console.log(`  level ${a.toFixed(3)} size v ${size[0].toFixed(4)} e ${size[1].toFixed(4)} | point bar ${a === 0.05 ? '0.0500' : ''} zSE bar@0.05 ${bar(0.05, sims).toFixed(4)} | power v ${pw[0].toFixed(4)} e ${pw[1].toFixed(4)} frechet ${(pw[0] + pw[1] - 1).toFixed(4)} joint ${joint.toFixed(4)}`);
    }
  }
} else {
  for (const fixed of [3, 4, 5, 6, 7, 8, 9]) {
    for (const [name, c] of [['bounds', cal.upper], ['point', cal.point]]) {
      const rand = seededRandom(cellSeed(20261110, 'r8f', name, fixed)); const nul = [];
      for (let i = 0; i < sims; i++) nul.push(run(c, rand, null, 0, fixed));
      const size = [0, 1].map((k) => nul.filter((r) => r[k][0] < 0.05).length / sims);
      const size25 = [0, 1].map((k) => nul.filter((r) => r[k][0] < 0.025).length / sims);
      console.log(`fixed ${fixed} ${name}: size@0.05 v ${size[0].toFixed(4)} e ${size[1].toFixed(4)} @0.025 v ${size25[0].toFixed(4)} e ${size25[1].toFixed(4)} ms ${Date.now() - t0}`);
    }
  }
}
console.log('ms', Date.now() - t0, 'zSE bars', bar(0.05, sims).toFixed(4), bar(0.025, sims).toFixed(4), '2SE bars', (0.05 + 2 * sd(0.0475 / sims)).toFixed(4));
