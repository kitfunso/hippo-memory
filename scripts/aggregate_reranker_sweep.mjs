#!/usr/bin/env node
/**
 * Aggregates per-track *.eval.json files in a sweep directory into one
 * summary.json keyed by track name.
 *
 * Usage:
 *   node scripts/aggregate_reranker_sweep.mjs results/reranker_sweep_<timestamp>/
 *
 * The aggregator stores the FULL eval.json payload per track (not a
 * projection). The result-doc author projects whichever fields they need.
 *
 * Per docs/plans/2026-05-10-f6-reranker-hardening.md Task 10 step 4-5.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const sweepDir = process.argv[2];
if (!sweepDir) {
  console.error('Usage: node scripts/aggregate_reranker_sweep.mjs <sweep-dir>');
  process.exit(1);
}

const summary = {};
for (const file of fs.readdirSync(sweepDir)) {
  if (!file.endsWith('.eval.json')) continue;
  const track = file.replace(/\.eval\.json$/, '');
  const data = JSON.parse(fs.readFileSync(path.join(sweepDir, file), 'utf8'));
  summary[track] = data;
}

const outPath = path.join(sweepDir, 'summary.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.error(`Wrote ${outPath} with ${Object.keys(summary).length} tracks.`);
