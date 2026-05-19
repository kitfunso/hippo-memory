#!/usr/bin/env node
/**
 * Compact version of run_hybrid_tuning.mjs that deletes JSONL files
 * after evaluating them to conserve disk space.
 * Produces the same eval.json + leaderboard.json outputs.
 * Also updates results/hybrid_tuning_winners.json after each stage.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STAGE = process.argv[2] ?? 'stage1';
const sweepDir = `results/hybrid_tuning_${new Date().toISOString().replace(/[:.]/g, '-')}_${STAGE}`;
fs.mkdirSync(sweepDir, { recursive: true });

const grids = {
  stage1: { embeddingWeight: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] },
  stage2: { mmrLambda: [0.0, 0.3, 0.5, 0.7, 1.0] },
  stage3: { budget: [50, 100, 500, 1000], minResults: [5, 10, 20, 50] },
};

const fixed = JSON.parse(fs.existsSync('results/hybrid_tuning_winners.json')
  ? fs.readFileSync('results/hybrid_tuning_winners.json', 'utf8')
  : '{}');

function runOne(label, args) {
  const out = path.join(sweepDir, `${label}.jsonl`);
  console.error(`\n=== ${label} ===`);
  const r = spawnSync('node', [
    'benchmarks/longmemeval/retrieve_inprocess.mjs',
    '--data', 'data/longmemeval_oracle.json',
    '--store-dir', 'hippo_store2',
    '--output', out,
    ...args,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Run ${label} failed exit=${r.status}`);

  // Evaluate immediately
  const evalOut = path.join(sweepDir, `${label}.eval.json`);
  console.error(`Evaluating ${label}...`);
  const ev = spawnSync('python3', [
    'benchmarks/longmemeval/evaluate_retrieval.py',
    '--retrieval', out,
    '--data', 'data/longmemeval_oracle.json',
    '--output', evalOut,
  ], { stdio: 'inherit' });
  if (ev.status !== 0) throw new Error(`Eval ${label} failed exit=${ev.status}`);

  // Delete JSONL to free disk space
  fs.rmSync(out);
  console.error(`Deleted ${out} to free disk space`);

  return evalOut;
}

const evalFiles = [];

if (STAGE === 'stage1') {
  for (const ew of grids.stage1.embeddingWeight) {
    evalFiles.push({ label: `ew_${ew}`, evalOut: runOne(`ew_${ew}`, ['--embedding-weight', String(ew)]) });
  }
} else if (STAGE === 'stage2') {
  if (fixed.embeddingWeight === undefined) throw new Error('Stage 2 requires fixed.embeddingWeight in results/hybrid_tuning_winners.json');
  for (const ml of grids.stage2.mmrLambda) {
    evalFiles.push({ label: `ml_${ml}`, evalOut: runOne(`ml_${ml}`, ['--embedding-weight', String(fixed.embeddingWeight), '--mmr-lambda', String(ml)]) });
  }
} else if (STAGE === 'stage3') {
  if (fixed.embeddingWeight === undefined || fixed.mmrLambda === undefined) {
    throw new Error('Stage 3 requires fixed.embeddingWeight and fixed.mmrLambda in results/hybrid_tuning_winners.json');
  }
  for (const b of grids.stage3.budget) {
    for (const mr of grids.stage3.minResults) {
      const label = `b${b}_mr${mr}`;
      evalFiles.push({ label, evalOut: runOne(label, [
        '--embedding-weight', String(fixed.embeddingWeight),
        '--mmr-lambda', String(fixed.mmrLambda),
        '--budget', String(b),
        '--min-results', String(mr),
      ]) });
    }
  }
} else {
  throw new Error(`Unknown stage: ${STAGE}`);
}

// Build leaderboard from eval files
const rows = [];
for (const { label, evalOut } of evalFiles) {
  const ev = JSON.parse(fs.readFileSync(evalOut, 'utf8'));
  rows.push({ label, ...ev.overall });
}
rows.sort((a, b) => (b['recall@5'] ?? 0) - (a['recall@5'] ?? 0));
fs.writeFileSync(path.join(sweepDir, 'leaderboard.json'), JSON.stringify(rows, null, 2));
console.log('\nlabel\trecall@1\trecall@3\trecall@5\trecall@10');
for (const r of rows) console.log(`${r.label}\t${r['recall@1']}\t${r['recall@3']}\t${r['recall@5']}\t${r['recall@10']}`);

// Update winners
const winnersPath = 'results/hybrid_tuning_winners.json';
const winners = fs.existsSync(winnersPath) ? JSON.parse(fs.readFileSync(winnersPath, 'utf8')) : {};
const top = rows[0].label;
if (top.startsWith('ew_')) winners.embeddingWeight = parseFloat(top.slice(3));
else if (top.startsWith('ml_')) winners.mmrLambda = parseFloat(top.slice(3));
else if (top.startsWith('b')) {
  const m3 = top.match(/^b(\d+)_mr(\d+)$/);
  if (m3) { winners.budget = parseInt(m3[1], 10); winners.minResults = parseInt(m3[2], 10); }
}
fs.writeFileSync(winnersPath, JSON.stringify(winners, null, 2));
console.error(`Updated ${winnersPath}: ${JSON.stringify(winners)}`);

console.error(`\nDone. Outputs in: ${sweepDir}`);
