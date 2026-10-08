import { test, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The harness imports the build, so the store it reads is seeded through the build too.
import { initStore } from '../../dist/store/open.js';
import { writeEntry } from '../../dist/store/entry-writes.js';
import { createMemory } from '../../dist/memory.js';

const FIXTURE = 'benchmarks/longmemeval/data/synthetic_smoke.json';

let scratch;

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('harness reads --mmr-lambda and passes it to hybridSearch', () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-harness-mmr-'));
  const hippoRoot = path.join(scratch, '.hippo');
  initStore(hippoRoot);
  for (const text of [
    'Production rollout of the new authentication flow is locked in for March 15, 2026',
    'The penetration test signs off before the authentication flow ships',
  ]) {
    writeEntry(hippoRoot, createMemory(text, { baseHalfLifeDays: 7 }));
  }
  const out = path.join(scratch, 'retrieval.jsonl');
  const result = spawnSync(process.execPath, [
    'benchmarks/longmemeval/retrieve_inprocess.mjs',
    '--data', FIXTURE,
    '--store-dir', scratch,
    '--output', out,
    '--limit', '2',
    '--mmr-lambda', '0.3',
  ], { encoding: 'utf-8', env: { ...process.env, HIPPO_HOME: path.join(scratch, 'global') } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/mmrLambda.*0\.3/);
  const records = fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(records.map((r) => r.question_id)).toEqual(['syn_001', 'syn_002']);
  expect(records[0].num_retrieved).toBeGreaterThan(0);
  expect(records.every((r) => r.error === undefined)).toBe(true);
});
