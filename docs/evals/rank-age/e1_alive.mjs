#!/usr/bin/env node
// Alive check for the rank-age prereg: share of final-epoch probes whose current-version rank differs between arms.
// Usage: node docs/evals/rank-age/e1_alive.mjs <dirA>:<arm> <dirB>:<arm> <first>-<last>
import * as fs from 'node:fs';
import * as path from 'node:path';

const [specA, specB, range] = process.argv.slice(2);
const [lo, hi] = range.split('-').map(Number);
const finalProbes = (spec, s) => {
  const cut = spec.lastIndexOf(':');
  const run = JSON.parse(fs.readFileSync(path.join(spec.slice(0, cut), `${spec.slice(cut + 1)}-seed${s}.json`), 'utf8'));
  return run.epochs[run.epochs.length - 1].probes;
};
let n = 0, differ = 0;
for (let s = lo; s <= hi; s++) {
  const a = finalProbes(specA, s), b = finalProbes(specB, s);
  if (a.length !== b.length) throw new Error(`seed ${s}: ${a.length} vs ${b.length} probe rows`);
  a.forEach((r, j) => {
    if (r.factId !== b[j].factId) throw new Error(`seed ${s} row ${j}: probe rows misaligned`);
    n++;
    if (r.rank !== b[j].rank || r.hit !== b[j].hit) differ++;
  });
}
console.log(JSON.stringify({ probes: n, differ, share: differ / n, alive: differ / n >= 0.01 }));
