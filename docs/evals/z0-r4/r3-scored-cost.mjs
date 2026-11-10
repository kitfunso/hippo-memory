// Read-only: list-price cost of round 3's scored records, each record's usage at the price file's Claude Code row.
// Usage: node docs/evals/z0-r4/r3-scored-cost.mjs --analyzer <checkout of 04835462b> [--report FILE] [--grading FILE] [--drop-list FILE]
import { openRound3 } from './r3-open.mjs';

const { f, prices, load } = await openRound3(['dist/eval/eval-stats.js']);
const { priceUsage, addUsage } = await load('dist/eval/eval-stats.js');

const cost = (r) => (r.usage ? priceUsage(addUsage(r.usage.firstSession, r.usage.extra), prices) : 0);
const byArm = {};
for (const r of f.scored) byArm[r.arm] = (byArm[r.arm] ?? 0) + cost(r);
const total = Object.values(byArm).reduce((a, b) => a + b, 0);
for (const arm of Object.keys(byArm).sort()) console.log(`${arm} ${byArm[arm].toFixed(2)}`);
console.log(`scored records ${f.scored.length}, cost ${total.toFixed(2)}`);
