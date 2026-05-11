#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sweepDir = process.argv[2];
if (!sweepDir) { console.error('Usage: node scripts/aggregate_hybrid_tuning.mjs <sweep-dir>'); process.exit(1); }

const dataPath = 'data/longmemeval_oracle.json';
const rows = [];
for (const f of fs.readdirSync(sweepDir)) {
  if (!f.endsWith('.jsonl')) continue;
  const label = f.replace(/\.jsonl$/, '');
  const evalOut = path.join(sweepDir, `${label}.eval.json`);
  if (!fs.existsSync(evalOut)) {
    spawnSync('python3', ['benchmarks/longmemeval/evaluate_retrieval.py',
      '--retrieval', path.join(sweepDir, f), '--data', dataPath, '--output', evalOut], { stdio: 'inherit' });
  }
  const ev = JSON.parse(fs.readFileSync(evalOut, 'utf8'));
  rows.push({ label, ...ev.overall });
}
rows.sort((a, b) => (b['recall@5'] ?? 0) - (a['recall@5'] ?? 0));
const leaderboard = rows;
fs.writeFileSync(path.join(sweepDir, 'leaderboard.json'), JSON.stringify(leaderboard, null, 2));
console.log('label\trecall@1\trecall@3\trecall@5\trecall@10');
for (const r of leaderboard) console.log(`${r.label}\t${r['recall@1']}\t${r['recall@3']}\t${r['recall@5']}\t${r['recall@10']}`);

const winnersPath = 'results/hybrid_tuning_winners.json';
const winners = fs.existsSync(winnersPath) ? JSON.parse(fs.readFileSync(winnersPath, 'utf8')) : {};
const top = leaderboard[0].label;
if (top.startsWith('ew_')) winners.embeddingWeight = parseFloat(top.slice(3));
else if (top.startsWith('ml_')) winners.mmrLambda = parseFloat(top.slice(3));
else if (top.startsWith('b')) {
  const m3 = top.match(/^b(\d+)_mr(\d+)$/);
  if (m3) { winners.budget = parseInt(m3[1], 10); winners.minResults = parseInt(m3[2], 10); }
}
fs.writeFileSync(winnersPath, JSON.stringify(winners, null, 2));
console.error(`Updated ${winnersPath}: ${JSON.stringify(winners)}`);
