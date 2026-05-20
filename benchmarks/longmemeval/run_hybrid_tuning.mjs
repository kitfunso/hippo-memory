#!/usr/bin/env node
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
  return out;
}

if (STAGE === 'stage1') {
  for (const ew of grids.stage1.embeddingWeight) {
    runOne(`ew_${ew}`, ['--embedding-weight', String(ew)]);
  }
} else if (STAGE === 'stage2') {
  if (fixed.embeddingWeight === undefined) throw new Error('Stage 2 requires fixed.embeddingWeight in results/hybrid_tuning_winners.json');
  for (const ml of grids.stage2.mmrLambda) {
    runOne(`ml_${ml}`, ['--embedding-weight', String(fixed.embeddingWeight), '--mmr-lambda', String(ml)]);
  }
} else if (STAGE === 'stage3') {
  if (fixed.embeddingWeight === undefined || fixed.mmrLambda === undefined) {
    throw new Error('Stage 3 requires fixed.embeddingWeight and fixed.mmrLambda in results/hybrid_tuning_winners.json');
  }
  for (const b of grids.stage3.budget) {
    for (const mr of grids.stage3.minResults) {
      runOne(`b${b}_mr${mr}`, [
        '--embedding-weight', String(fixed.embeddingWeight),
        '--mmr-lambda', String(fixed.mmrLambda),
        '--budget', String(b),
        '--min-results', String(mr),
      ]);
    }
  }
} else {
  throw new Error(`Unknown stage: ${STAGE}`);
}

console.error(`\nDone. Outputs in: ${sweepDir}`);
