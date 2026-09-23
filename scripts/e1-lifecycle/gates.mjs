#!/usr/bin/env node
// Recomputes the prereg's E1 workload-validity gates from the final epoch of each run file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: gates.mjs <campaign dir holding hl7/ and hl365/>');
const SEEDS = Array.from({ length: 20 }, (_, i) => 21 + i);

const final = (hl, arm, seed) => {
  const run = JSON.parse(readFileSync(join(dir, `hl${hl}`, `${arm}-seed${seed}.json`), 'utf8'));
  return run.epochs[run.epochs.length - 1];
};

function gate(name, hl, pass, show) {
  const rows = SEEDS.map((s) => pass(s));
  const n = rows.filter(Boolean).length;
  console.log(`${name} hl${hl}: ${n}/20 seeds pass (needs 18) ${show()}`);
}

gate('L2 full@7 currentR5 < all-off@7', 7,
  (s) => final(7, 'full', s).currentR5 < final(7, 'all-off', s).currentR5, () => '');
for (const hl of [7, 365]) {
  const trap = SEEDS.map((s) => final(hl, 'outcome-off', s).trapPersistenceRate);
  gate('L3a outcome-off trap >= 0.20', hl, (s) => final(hl, 'outcome-off', s).trapPersistenceRate >= 0.2,
    () => `min ${Math.min(...trap).toFixed(3)}`);
  const hot = SEEDS.map((s) => final(hl, 'strengthen-off', s).hotR5);
  gate('L3b strengthen-off hotR5 <= 0.90', hl, (s) => final(hl, 'strengthen-off', s).hotR5 <= 0.9,
    () => `max ${Math.max(...hot).toFixed(3)}`);
}
