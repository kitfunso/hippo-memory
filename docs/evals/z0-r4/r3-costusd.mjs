// Read-only: does round 3's costUsd (Claude Code's total_cost_usd) equal the record's usage at the price file's row?
// Usage: node docs/evals/z0-r4/r3-costusd.mjs --analyzer <checkout of 04835462b> [--report FILE] [--grading FILE] [--drop-list FILE]
import { openRound3 } from './r3-open.mjs';

const { inputs, prices, load } = await openRound3(['dist/eval/eval-stats.js']);
const { priceUsage, addUsage } = await load('dist/eval/eval-stats.js');

const records = inputs.records.filter((r) => Number.isFinite(r.costUsd) && r.usage && r.tool === 'claude-code');
let recorded = 0;
let priced = 0;
let outside = 0;
const ratios = [];
for (const r of records) {
  const c = priceUsage(addUsage(r.usage.firstSession, r.usage.extra), prices);
  recorded += r.costUsd;
  priced += c;
  if (Math.abs(r.costUsd - c) > 0.001 * c) outside++;
  if (c > 0) ratios.push(r.costUsd / c);
}
ratios.sort((x, y) => x - y);
const at = (q) => ratios[Math.floor(ratios.length * q)].toFixed(3);
console.log(`records ${records.length}, sum costUsd ${recorded.toFixed(2)}, sum priced ${priced.toFixed(2)}, ratio ${(recorded / priced).toFixed(4)}, p05 ${at(0.05)}, p50 ${at(0.5)}, p95 ${at(0.95)}`);
console.log(`outside 0.1%: ${outside} of ${records.length}`);
