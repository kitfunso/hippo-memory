import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

// Integration test: shells out to retrieve_inprocess.mjs against a hippo
// store at hippo_store_synthetic/. The store is gitignored (.gitignore:29 —
// it's populated by F6 tooling, not source-tracked), so in a clean CI
// checkout the directory is absent and the harness exits with
// "Store not found". When the prerequisites are missing we skip instead of
// failing, so the default `npm test` stays reliably green. The fixture
// (synthetic_smoke.json) IS committed, so a developer can produce the store
// by running the F6 ingest tooling, after which this test runs in full.
const FIXTURE = 'benchmarks/longmemeval/data/synthetic_smoke.json';
const STORE_DIR = 'hippo_store_synthetic/.hippo';
const prereqsMet = fs.existsSync(FIXTURE) && fs.existsSync(STORE_DIR);

test.skipIf(!prereqsMet)(
  'harness reads --mmr-lambda and passes it to hybridSearch',
  () => {
    const out = `/tmp/harness_mmr_test_${Date.now()}.jsonl`;
    const result = spawnSync('node', [
      'benchmarks/longmemeval/retrieve_inprocess.mjs',
      '--data', FIXTURE,
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
  },
);
