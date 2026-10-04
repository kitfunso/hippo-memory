// One hybrid recall over a 10k-row store with 384-dim vectors stays interactive; prints the measured median.

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, batchWriteAndDelete } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { saveEmbeddingIndex, saveStoredEmbeddingModel } from '../src/embeddings.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';
import { searchBothHybrid } from '../src/shared.js';

const ROWS = 10_000;
const DIM = 384;
const BOUND_MS = 3_000;

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

  it(`a searchBothHybrid call finishes under ${BOUND_MS} ms`, async () => {
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

    const times: number[] = [];
    for (let run = 0; run < 4; run++) {
      const t0 = performance.now();
      const res = await searchBothHybrid('deploy pipeline', home, global, { budget: 4000, tenantId: 'default', recallScope: {}, scope: null });
      times.push(performance.now() - t0);
      expect(res.length).toBeGreaterThan(0);
    }
    const median = times.slice(1).sort((a, b) => a - b)[1];
    console.log(`hybrid recall at ${ROWS} rows: median ${median.toFixed(0)} ms (runs ${times.map((t) => t.toFixed(0)).join(', ')})`);
    expect(median).toBeLessThan(BOUND_MS);
  }, 120_000);
});
