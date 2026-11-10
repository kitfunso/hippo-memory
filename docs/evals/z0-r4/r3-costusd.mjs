// Read-only: does round 3's costUsd (Claude Code's total_cost_usd) equal the record's usage at the price file's row?
// Usage: node docs/evals/z0-r4/r3-costusd.mjs --analyzer <checkout of 04835462b> [--scored C:/z0-runs/scored]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const checkout = arg('--analyzer', null);
if (checkout === null) throw new Error('--analyzer <checkout of 04835462b> is required');
const scored = arg('--scored', 'C:/z0-runs/scored');
const { loadInputs } = await import(pathToFileURL(path.join(checkout, 'scripts/token-eval/z0-analyze.mjs')).href);
const { priceUsage, addUsage } = await import(pathToFileURL(path.join(checkout, 'dist/eval/eval-stats.js')).href);

// The run folders and file choice of C:/z0-runs/scored/r3-final-read.sh:8-14.
const runs = [];
const plan = [];
const folders = fs.readdirSync(`${scored}/r3run`).filter((n) => (n.endsWith('-w1') || n === 'gr3-w1b' || /-e[0-9]$/.test(n)) && n !== 'gr3-w1');
for (const n of folders.sort()) {
  const src = fs.existsSync(`${scored}/r3-merged/${n}`) ? `${scored}/r3-merged/${n}` : `${scored}/r3run/${n}/run`;
  runs.push(fs.existsSync(`${src}/runs.regraded.jsonl`) ? `${src}/runs.regraded.jsonl` : `${src}/runs.jsonl`);
  plan.push(`${src}/plan.json`);
}
const inputs = loadInputs({ runs, plan, prices: 'C:/z0-runs/s7/prices.json', grading: null, dropList: null, out: null }, process.cwd());
const row = inputs.prices['claude-code'];
const records = inputs.records.filter((r) => Number.isFinite(r.costUsd) && r.usage && r.tool === 'claude-code');
let recorded = 0;
let priced = 0;
const ratios = [];
for (const r of records) {
  const c = priceUsage(addUsage(r.usage.firstSession, r.usage.extra), row);
  recorded += r.costUsd;
  priced += c;
  if (c > 0) ratios.push(r.costUsd / c);
}
ratios.sort((x, y) => x - y);
const at = (q) => ratios[Math.floor(ratios.length * q)].toFixed(3);
console.log(`records ${records.length}, sum costUsd ${recorded.toFixed(2)}, sum priced ${priced.toFixed(2)}, ratio ${(recorded / priced).toFixed(4)}, p05 ${at(0.05)}, p50 ${at(0.5)}, p95 ${at(0.95)}`);
