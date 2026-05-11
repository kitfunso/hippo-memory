import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

test('harness reads --mmr-lambda and passes it to hybridSearch', () => {
  const dataPath = 'benchmarks/longmemeval/data/synthetic_smoke.json';
  if (!fs.existsSync(dataPath)) {
    expect.fail(`fixture missing: ${dataPath} — F6 should have created it`);
  }
  const out = `/tmp/harness_mmr_test_${Date.now()}.jsonl`;
  const result = spawnSync('node', [
    'benchmarks/longmemeval/retrieve_inprocess.mjs',
    '--data', dataPath,
    '--store-dir', 'hippo_store_synthetic',
    '--output', out,
    '--limit', '2',
    '--mmr-lambda', '0.3',
  ], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`harness exited ${result.status}: ${result.stderr}`);
  }
  expect(result.stderr).toMatch(/mmrLambda.*0\.3/);
  expect(fs.existsSync(out)).toBe(true);
  fs.unlinkSync(out);
});
