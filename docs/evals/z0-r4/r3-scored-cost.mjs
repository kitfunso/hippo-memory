// Read-only: list-price cost of round 3's scored records, each record's usage at the price file's Claude Code row.
// Usage: node docs/evals/z0-r4/r3-scored-cost.mjs --analyzer <checkout of 04835462b> [--scored C:/z0-runs/scored] [--drop-list <file>]
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
const dropFile = arg('--drop-list', null);
const tokenEval = path.join(checkout, 'scripts/token-eval');
const load = (file) => import(pathToFileURL(path.join(tokenEval, file)).href);
const { loadInputs } = await load('z0-analyze.mjs');
const { filterRecords } = await load('z0-filters.mjs');
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
const inputs = loadInputs({ runs, plan, prices: 'C:/z0-runs/s7/prices.json', grading: `${scored}/r3-final/grading.json`, dropList: dropFile, out: null }, process.cwd());
const row = inputs.prices['claude-code'];
const cost = (r) => (r.usage ? priceUsage(addUsage(r.usage.firstSession, r.usage.extra), row) : 0);
const kept = filterRecords(inputs.records, inputs.planCells, { grading: inputs.grading, dropList: inputs.dropList }).scored;
const byArm = {};
for (const r of kept) byArm[r.arm] = (byArm[r.arm] ?? 0) + cost(r);
const total = Object.values(byArm).reduce((a, b) => a + b, 0);
console.log(`folders ${folders.length}, records read ${inputs.records.length}, drop list ${dropFile ?? 'none'}`);
for (const arm of Object.keys(byArm).sort()) console.log(`${arm} ${byArm[arm].toFixed(2)}`);
console.log(`scored records ${kept.length}, cost ${total.toFixed(2)}`);
