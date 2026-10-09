// One hybrid recall over a 10k-row store with 384-dim vectors does a bounded amount of work; prints the measured time.

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
const FEWER_ROWS = ROWS / 10;
const DIM = 384;
// Ten times the rows may read ten times the rows, and no more.
const MAX_GROWTH = ROWS / FEWER_ROWS;
// The statements a recall runs and the rows it reads are the same on every runner.
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
  const fewer = mkdtempSync(join(tmpdir(), 'hippo-1k-'));
  const global = mkdtempSync(join(tmpdir(), 'hippo-10k-global-'));
  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    rmSync(home, { recursive: true, force: true });
    rmSync(fewer, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  });

  const recall = (store: string): ReturnType<typeof searchBothHybrid> =>
    searchBothHybrid('deploy pipeline', store, global, { budget: 4000, tenantId: 'default', recallScope: {}, scope: null });
  const recallOnce = (): ReturnType<typeof searchBothHybrid> => recall(home);

  function seed(store: string, rows: number): void {
    writeFileSync(join(store, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'text-embedding-3-small' } }), 'utf8');
    initStore(store);
    const entries = Array.from({ length: rows }, (_, i) =>
      createMemory(`note ${i} about ${i % 50 === 0 ? 'deploy pipeline' : 'topic'} ${i % 97}`, { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    batchWriteAndDelete(store, entries, []);
    saveEmbeddingIndex(store, Object.fromEntries(entries.map((e, i) => [e.id, vector(i + 1)])));
  }

  beforeAll(() => {
    initStore(global);
    seed(home, ROWS);
    seed(fewer, FEWER_ROWS);
    process.env.OPENAI_API_KEY = 'sk-test';
    for (const store of [home, fewer]) saveStoredEmbeddingModel(store, resolveEmbeddingProvider(store).id);
    const queryVector = vector(7);
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: queryVector }] }), { status: 200 })));
  }, 120_000);

  it('a recall over ten times the rows runs no more statements and reads at most ten times the rows', async () => {
    let t0 = performance.now();
    const atRows = await recordStatementsAsync(() => recall(home));
    const msAtRows = performance.now() - t0;
    t0 = performance.now();
    const atFewer = await recordStatementsAsync(() => recall(fewer));
    console.log(`hybrid recall: ${msAtRows.toFixed(0)} ms at ${ROWS} rows, ${(performance.now() - t0).toFixed(1)} ms at ${FEWER_ROWS} (printed, not asserted)`);
    expect(atFewer.result.length).toBeGreaterThan(0);
    // The smaller recall ran its vector scan too, so the two counts compare like with like.
    expect(atFewer.rowsRead).toBeGreaterThanOrEqual(FEWER_ROWS);
    // A query per row scored, or per chunk of rows, grows the statements with the store.
    expect(atRows.statements.length).toBeLessThanOrEqual(atFewer.statements.length);
    expect(atRows.rowsRead).toBeLessThanOrEqual(MAX_GROWTH * atFewer.rowsRead);
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
