// GET /v1/memories ignored `mode` and never strengthened what it returned,
// so HTTP callers got a flat BM25 band and their memories decayed as if unread.

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { __resetSessionRecallHistoryHttp } from '../../src/entry/testing.js';
import { retrieve, supersede } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEntriesByIds, loadLastRecall, writeEntry } from '../_helpers/root-forms.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  home = makeRoot('http-recall-mode');
  // The better BM25 match has decayed for years; hybrid scoring must see that.
  const old = '2020-01-01T00:00:00.000Z';
  const weak = {
    ...createMemory('alpha alpha beta', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    created: old,
    last_retrieved: old,
    half_life_days: 1,
  };
  const strong = createMemory('alpha gamma delta', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(home, weak);
  writeEntry(home, strong);
  weakId = weak.id;
  strongId = strong.id;
  handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await handle.stop();
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
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'test', role: 'admin' });
    const { newId } = await supersede(ctx, weakId, 'alpha epsilon zeta');
    const ids = await recallIds(`q=alpha&mode=${mode}`);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(weakId);
    expect((await retrieve(ctx, { query: 'alpha' })).results.map((r) => r.id)).not.toContain(weakId);
  });

  it('strengthens every returned row and leaves last_retrieval_ids alone', async () => {
    await recallIds('q=alpha');
    const rows = loadEntriesByIds(home, [weakId, strongId]);
    expect(rows.map((r) => r.retrieval_count)).toEqual([1, 1]);
    expect(rows.every((r) => r.last_retrieved > '2026-01-01')).toBe(true);
    expect(loadLastRecall(home).last_retrieval_ids).toEqual([]);
  });
});
