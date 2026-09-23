#!/usr/bin/env node
// CI lint gate. The repo carries hundreds of older oxlint hits, so a plain `oxlint` exit code would fail
// every PR; instead each rule's hit count may fall but never rise above .oxlint-baseline.json.
// After fixing hits, `node scripts/check-lint-ratchet.mjs --update` lowers the baseline.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE = '.oxlint-baseline.json';

const lint = spawnSync(process.execPath, ['node_modules/oxlint/bin/oxlint', '-f', 'json'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
const report = JSON.parse(lint.stdout);
const counts = {};
for (const d of report.diagnostics) counts[d.code] = (counts[d.code] ?? 0) + 1;
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${report.diagnostics.length} hits over ${Object.keys(sorted).length} rules.`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const rose = Object.entries(sorted).filter(([rule, n]) => n > (baseline[rule] ?? 0));
const fell = Object.entries(baseline).filter(([rule, n]) => (sorted[rule] ?? 0) < n);

if (rose.length > 0) {
  console.error('oxlint hits rose above the baseline:');
  for (const [rule, n] of rose) console.error(`  ${rule}: ${baseline[rule] ?? 0} -> ${n}`);
  console.error('Run `npx oxlint` and fix the new hits in the files you changed.');
  process.exit(1);
}
if (fell.length > 0) {
  console.log(`${fell.length} rules fell below the baseline; run \`node scripts/check-lint-ratchet.mjs --update\` to lock that in.`);
}
console.log(`Lint ratchet OK: ${report.diagnostics.length} hits, none above ${BASELINE}.`);
