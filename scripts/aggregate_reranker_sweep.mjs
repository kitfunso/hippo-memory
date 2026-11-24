#!/usr/bin/env node
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
