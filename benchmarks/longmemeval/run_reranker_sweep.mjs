#!/usr/bin/env node
/**
 * Runs the LongMemEval retrieval harness across all reranker tracks plus
 * baseline. Output (one JSONL per run, in a timestamped dir):
 *   results/reranker_sweep_<timestamp>/
 *     baseline.jsonl
 *     features_topk20.jsonl
 *     features_topk50.jsonl
 *     features_topk100.jsonl
 *     cross_encoder_topk50.jsonl
 *
 * R@K aggregation is a separate post-step: run `evaluate.py` per file, then
 * `scripts/aggregate_reranker_sweep.mjs` (per the plan's Task 10 Step 4) to
 * produce summary.json. This script does not aggregate on its own.
 *
 * Per docs/plans/2026-05-10-f6-reranker-hardening.md Task 9.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA = process.env.LONGMEMEVAL_DATA ?? 'data/longmemeval_oracle.json';
const STORE = process.env.LONGMEMEVAL_STORE ?? 'hippo_store2';
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = `results/reranker_sweep_${ts}`;
fs.mkdirSync(outDir, { recursive: true });

const runs = [
  { name: 'baseline', flags: [] },
  { name: 'features_topk20', flags: ['--reranker', 'features', '--reranker-top-k', '20'] },
  { name: 'features_topk50', flags: ['--reranker', 'features', '--reranker-top-k', '50'] },
  { name: 'features_topk100', flags: ['--reranker', 'features', '--reranker-top-k', '100'] },
  { name: 'cross_encoder_topk50', flags: ['--reranker', 'cross-encoder', '--reranker-top-k', '50'] },
];

for (const r of runs) {
  const out = path.join(outDir, `${r.name}.jsonl`);
  console.error(`\n=== ${r.name} ===`);
  const cmd = [
    'node',
    'benchmarks/longmemeval/retrieve_inprocess.mjs',
    '--data', DATA,
    '--store-dir', STORE,
    '--output', out,
    ...r.flags,
  ].join(' ');
  execSync(cmd, { stdio: 'inherit' });
}

console.error(`\nAll runs complete: ${outDir}`);
console.error(`Run evaluate.py per file to get R@K metrics, then aggregate into summary.json.`);
