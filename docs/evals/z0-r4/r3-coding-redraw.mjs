// Read-only: four ways to build the item 10 redraw on round 3's A2/A1 H1 spreads, seed rule in the loop, at an effect
// where each coding's power is near 0.8. unit = fresh family, seed and residual per unit (the prereg's words);
// resid = fresh residual only; family = a whole family redrawn; shrink = every part at correlation 1 - f (marginals kept).
// Usage: node docs/evals/z0-r4/r3-coding-redraw.mjs --analyzer <checkout of 04835462b> [--sims 2000] [--delta -0.11] [--level 0.025] [--report FILE] [--grading FILE] [--drop-list FILE]
import { arg, openRound3 } from './r3-open.mjs';

const { load, scoredNoDrop } = await openRound3(['scripts/token-eval/z0-hypotheses.mjs', 'scripts/token-eval/z0-size-sim.mjs', 'dist/eval/eval-stats.js']);
const { repeatT, repeatMistakeUnits, firstApplyR, CODINGS } = await load('scripts/token-eval/z0-hypotheses.mjs');
const { seedsNeeded, spreadComponents, normal, cellSeed } = await load('scripts/token-eval/z0-size-sim.mjs');
const { seededRandom } = await load('dist/eval/eval-stats.js');
const s = scoredNoDrop();
const DROP = new Set(['hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1']);
const sd = Math.sqrt;
const lessons = s.filter((r) => (r.arm === 'A2' || r.arm === 'A1') && r.kind === 'apply' && firstApplyR(r)).flatMap((r) => r.lessons);
const na = lessons.filter((l) => l.first === 'na').length / lessons.length;
const cal = {}; let layout;
for (const coding of CODINGS) {
  const { units, dropped } = repeatMistakeUnits(s, 'A2', 'A1', coding, firstApplyR);
  const k = spreadComponents(units, 0.8);
  cal[coding] = { scale: coding === 'violation' ? 1 - na : 1, loss: dropped.length / (units.length + dropped.length), family: k.family, sequence: k.sequence, noise: k.noise };
  if (layout === undefined) { const m = new Map(); for (const u of units) if (!DROP.has(u.family)) (m.get(u.repo) ?? m.set(u.repo, new Set()).get(u.repo)).add(u.family); layout = [...m.values()].map((x) => x.size); }
}
function run(mode, f, rand, rand2, rule, delta) {
  const rho = 1 - f, sh = sd(1 - rho * rho);
  const zf = layout.map((k) => Array.from({ length: k }, () => normal(rand)));
  const zf2 = layout.map((k) => Array.from({ length: k }, () => normal(rand2)));
  const famCoin = layout.map((k) => Array.from({ length: k }, () => rand2() < f));
  const units = { [CODINGS[0]]: [], [CODINGS[1]]: [] }; let seeds = 0;
  const addSeed = () => {
    seeds++;
    layout.forEach((k, r) => {
      const [zq, zq2] = [normal(rand), normal(rand2)];
      for (let g = 0; g < k; g++) {
        const [ze, u] = [normal(rand), rand()];
        const [coin, fz] = [rand2() < f, [normal(rand2), normal(rand2), normal(rand2)]];
        CODINGS.forEach((coding, i) => {
          const q = c[coding]; if (u < q.loss) return;
          let z = [zf[r][g], zq, ze];
          if (i === 1 && mode === 'unit' && coin) z = fz;
          if (i === 1 && mode === 'resid' && coin) z = [zf[r][g], zq, fz[2]];
          if (i === 1 && mode === 'family' && famCoin[r][g]) z = [zf2[r][g], zq, fz[2]];
          if (i === 1 && mode === 'shrink') z = [rho * zf[r][g] + sh * zf2[r][g], rho * zq + sh * zq2, rho * ze + sh * fz[2]];
          units[coding].push({ repo: `r${r}`, family: `r${r}f${g}`, seed: seeds, value: q.scale * delta + sd(q.family) * z[0] + sd(q.sequence) * z[1] + sd(q.noise) * z[2] });
        });
      }
    });
  };
  const c = cal;
  while (seeds < 3) addSeed();
  const need = CODINGS.map((k) => seedsNeeded(units[k], rule.m, rule)); const n = Math.max(...need.map((x) => x ?? rule.cap)); while (seeds < n) addSeed();
  return units;
}
const [sims, delta, level] = [Number(arg('--sims', 2000)), Number(arg('--delta', -0.11)), Number(arg('--level', 0.025))];
const rule = { m: 0.15, cap: 9, targetZ: 3.5 };
console.log(`A2/A1 spreads, effect ${delta}, level ${level}, ${sims} draws`);
for (const [mode, f] of [['unit', 0], ['unit', 2 / 48], ['unit', 0.25], ['unit', 1], ['resid', 0.25], ['resid', 1], ['family', 0.25], ['family', 1], ['shrink', 2 / 48], ['shrink', 0.25], ['shrink', 1]]) {
  const rand = seededRandom(cellSeed(20261110, 'r12c')); const rand2 = seededRandom(cellSeed(20261110, 'r12d'));
  let w = [0, 0], joint = 0;
  for (let i = 0; i < sims; i++) {
    const u = run(mode, f, rand, rand2, rule, delta);
    const win = CODINGS.map((k) => { const e = repeatT(u[k], {}); return e.p < level && e.estimate < 0; });
    w = w.map((x, j) => x + win[j]); joint += win[0] && win[1];
  }
  const [p0, p1] = w.map((x) => x / sims);
  console.log(`${mode.padEnd(6)} f ${f.toFixed(4)} power ${p0.toFixed(4)} / ${p1.toFixed(4)} joint ${(joint / sims).toFixed(4)} frechet ${(p0 + p1 - 1).toFixed(4)} product ${(p0 * p1).toFixed(4)}`);
}
