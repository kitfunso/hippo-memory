// Read-only: round 3, sets R+N, seeds 1-3. Part (b)'s harmT resolve difference against the pooled task-level difference, per arm pair.
// Usage: node docs/evals/z0-r4/r3-resolve.mjs --analyzer <checkout of 04835462b> [--report FILE] [--grading FILE] [--drop-list FILE]
import { openRound3 } from './r3-open.mjs';

const { api, prices, scoredNoDrop } = await openRound3();
const s = scoredNoDrop().filter((r) => r.seed <= 3);
for (const [t, c] of [['A2', 'A1'], ['A5', 'A1'], ['A2', 'A5'], ['A0', 'A1'], ['A4', 'A1'], ['A0', 'A4']]) {
  const u = api.taskUnits(s, t, c, prices, api.inSets('R', 'N'));
  if (u.length === 0) { console.log(t, c, 'no units'); continue; }
  const h = api.harmT(u, {});
  const pooled = (u.reduce((a, x) => a + x.t.resolved, 0) - u.reduce((a, x) => a + x.c.resolved, 0)) / u.length;
  console.log(JSON.stringify({ pair: `${t}/${c}`, tasks: u.length, partB: +h.resolveDiff.estimate.toFixed(4), low: +h.resolveDiff.low.toFixed(4), pooled: +pooled.toFixed(4), gap: +(h.resolveDiff.estimate - pooled).toFixed(4) }));
}
