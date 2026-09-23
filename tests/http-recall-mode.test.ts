// GET /v1/memories ignored `mode` and never strengthened what it returned,
// so HTTP callers got a flat BM25 band and their memories decayed as if unread.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import { initStore, writeEntry, loadEntriesByIds, loadIndex } from '../src/store.js';
import { serve, __resetSessionRecallHistoryHttp, type ServerHandle } from '../src/server.js';
import { recall, supersede, type Context } from '../src/api.js';

let home: string;
let handle: ServerHandle;
let weakId: string;
let strongId: string;

async function recallIds(qs: string): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/v1/memories?${qs}`);
  expect(res.status).toBe(200);
  // SAFETY: a 200 from this route always carries a results array of recall items.
  const body = (await res.json()) as { results: { id: string }[] };
  return body.results.map((r) => r.id);
}

beforeEach(async () => {
  __resetSessionRecallHistoryHttp();
  home = mkdtempSync(join(tmpdir(), 'hippo-http-recall-mode-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  // The better BM25 match has decayed for years; hybrid scoring must see that.
  const old = '2020-01-01T00:00:00.000Z';
  const weak = { ...createMemory('alpha alpha beta'), created: old, last_retrieved: old, half_life_days: 1 };
  const strong = createMemory('alpha gamma delta');
  writeEntry(home, weak);
  writeEntry(home, strong);
  weakId = weak.id;
  strongId = strong.id;
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('GET /v1/memories honours mode and strengthens', () => {
  it('mode=bm25 keeps the BM25 order', async () => {
    expect(await recallIds('q=alpha&mode=bm25')).toEqual([weakId, strongId]);
  });

  it('mode=hybrid reorders the same window by strength and recency', async () => {
    expect(await recallIds('q=alpha&mode=hybrid')).toEqual([strongId, weakId]);
  });

  it('mode=hybrid keeps the recency fallback for a query that matches nothing', async () => {
    expect((await recallIds('q=zzzznothingmatches&mode=hybrid')).sort()).toEqual([weakId, strongId].sort());
  });

  it.each(['bm25', 'hybrid'])('mode=%s and api.recall never return a superseded row', async (mode) => {
    const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'test', role: 'admin' } };
    const { newId } = supersede(ctx, weakId, 'alpha epsilon zeta');
    const ids = await recallIds(`q=alpha&mode=${mode}`);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(weakId);
    expect(recall(ctx, { query: 'alpha' }).results.map((r) => r.id)).not.toContain(weakId);
  });

  it('strengthens every returned row and leaves last_retrieval_ids alone', async () => {
    await recallIds('q=alpha');
    const rows = loadEntriesByIds(home, [weakId, strongId]);
    expect(rows.map((r) => r.retrieval_count)).toEqual([1, 1]);
    expect(rows.every((r) => r.last_retrieved > '2026-01-01')).toBe(true);
    expect(loadIndex(home).last_retrieval_ids).toEqual([]);
  });
});
