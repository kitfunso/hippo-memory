// Read-only: round 3 scored records, seeds 1-3. Per pair, the family units whose value differs between the two
// codings or that one coding drops (the prereg item 10 count), in batch 1 and over all 29 repositories.
// Usage: node docs/evals/z0-r4/r3-coding-units.mjs --analyzer <checkout of 04835462b> [--report FILE] [--grading FILE] [--drop-list FILE]
import { openRound3 } from './r3-open.mjs';

const { load, scoredNoDrop } = await openRound3(['scripts/token-eval/z0-hypotheses.mjs']);
const { repeatMistakeUnits, firstApplyR, CODINGS } = await load('scripts/token-eval/z0-hypotheses.mjs');
const all = scoredNoDrop();
const B1 = ['q12', 'q14', 'q140', 'q145', 'q184', 'q190', 'q212', 'q222', 'q226', 'q238'];
const inB1 = (rp) => B1.some((k) => rp.includes('/' + k + '-r/'));
for (const maxSeed of [3, 99]) {
  const s = all.filter((r) => r.seed <= maxSeed);
  for (const [t, c] of [['A2', 'A1'], ['A2', 'A5']]) {
    const by = Object.fromEntries(CODINGS.map((k) => [k, new Map(repeatMistakeUnits(s, t, c, k, firstApplyR).units.map((u) => [`${u.repo}|${u.family}|${u.seed}`, u.value]))]));
    const [a, b] = CODINGS;
    const keys = new Set([...by[a].keys(), ...by[b].keys()]);
    const odd = [...keys].filter((k) => !by[a].has(k) || !by[b].has(k) || by[a].get(k) !== by[b].get(k));
    const b1Units = [...keys].filter((k) => inB1(k.split('|')[0]));
    const b1Odd = odd.filter((k) => inB1(k.split('|')[0]));
    console.log(JSON.stringify({ seeds: maxSeed === 3 ? '1-3' : 'all', pair: `${t}/${c}`, units: keys.size, odd: odd.length, b1Units: b1Units.length, b1Odd: b1Odd.length, oddList: odd.map((k) => k.replace(/^.*\/(q\w+|hu\w+|gr\w+)-r\/[^|]*/, '$1')) }));
  }
}
