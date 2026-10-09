// One hybrid recall over a 10k-row store with 384-dim vectors stays interactive and does a bounded amount of work; prints the measured median.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { batchWriteAndDelete } from '../src/store/delete-and-batch.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { saveEmbeddingIndex, saveStoredEmbeddingModel } from '../src/embeddings.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';
import { searchBothHybrid } from '../src/shared.js';
import { recordStatementsAsync } from './_helpers/count-statements.js';

const ROWS = 10_000;
const DIM = 384;
const BOUND_MS = 3_000;
// The wall clock moves with the runner; the statements a recall runs and the rows it reads do not.
const MAX_ROWS_READ = 13_000;
const MAX_STATEMENTS = 80;

function vector(seed: number): number[] {
  let x = seed * 2654435761 % 4294967296;
  return Array.from({ length: DIM }, () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296 - 0.5;
  });
}

describe('hybrid recall at 10k rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-10k-'));
  const global = mkdtempSync(join(tmpdir(), 'hippo-10k-global-'));
  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    rmSync(home, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  });

  const recallOnce = (): ReturnType<typeof searchBothHybrid> =>
    searchBothHybrid('deploy pipeline', home, global, { budget: 4000, tenantId: 'default', recallScope: {}, scope: null });

  beforeAll(() => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'text-embedding-3-small' } }), 'utf8');
    initStore(home);
    initStore(global);
    const entries = Array.from({ length: ROWS }, (_, i) =>
      createMemory(`note ${i} about ${i % 50 === 0 ? 'deploy pipeline' : 'topic'} ${i % 97}`, { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    batchWriteAndDelete(home, entries, []);
    saveEmbeddingIndex(home, Object.fromEntries(entries.map((e, i) => [e.id, vector(i + 1)])));
    process.env.OPENAI_API_KEY = 'sk-test';
    saveStoredEmbeddingModel(home, resolveEmbeddingProvider(home).id);
    const queryVector = vector(7);
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: queryVector }] }), { status: 200 })));
  }, 120_000);

  it(`a searchBothHybrid call finishes under ${BOUND_MS} ms`, async () => {
    const times: number[] = [];
    for (let run = 0; run < 4; run++) {
      const t0 = performance.now();
      const res = await recallOnce();
      times.push(performance.now() - t0);
      expect(res.length).toBeGreaterThan(0);
    }
    const median = times.slice(1).sort((a, b) => a - b)[1];
    console.log(`hybrid recall at ${ROWS} rows: median ${median.toFixed(0)} ms (runs ${times.map((t) => t.toFixed(0)).join(', ')})`);
    expect(median).toBeLessThan(BOUND_MS);
  }, 120_000);

  it('one recall reads each stored vector once and few other rows', async () => {
    const { result, statements, rowsRead } = await recordStatementsAsync(recallOnce);
    expect(result.length).toBeGreaterThan(0);
    // Every stored vector is read, so the ceilings below measure a recall that ran its vector scan.
    expect(rowsRead).toBeGreaterThanOrEqual(ROWS);
    // About 1.3 times what one recall does; a second vector scan or a whole-store load of memories passes it.
    expect(rowsRead).toBeLessThanOrEqual(MAX_ROWS_READ);
    expect(statements.length).toBeLessThanOrEqual(MAX_STATEMENTS);
  }, 120_000);
});
