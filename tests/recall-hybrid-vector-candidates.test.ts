// Pins which rows hybrid recall returns when vectors exist: the CLI shared-store path, api.retrieve and the plain hybrid pool.
// Ids are random per seed, so rows are named by label.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadRecallSearchEntries } from '../src/store/search-rows.js';
import { createMemory, type CreateMemoryOptions } from '../src/memory.js';
import { saveEmbeddingIndex, saveStoredEmbeddingModel } from '../src/embeddings.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';
import { searchBothHybrid } from '../src/shared.js';
import { hybridSearch } from '../src/search/hybrid.js';
import { retrieve, getContext } from '../src/api.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';

const NOW = '2026-09-01T12:00:00.000Z';
const TENANT = 'default';
const QUERY = 'deploy pipeline';

interface Seeded {
  home: string;
  global: string;
  labelById: Map<string, string>;
  idByLabel: Map<string, string>;
}

function add(s: Seeded, label: string, content: string, opts: Partial<CreateMemoryOptions> = {}): void {
  const entry = createMemory(content, { baseHalfLifeDays: 7, tenantId: TENANT, ...opts });
  writeEntry(s.home, entry);
  s.labelById.set(entry.id, label);
  s.idByLabel.set(label, entry.id);
}

/** S1 and S2 share no word with the query; SC1, PR1 and LG1 sit in scopes default recall denies. */
function seed(): Seeded {
  const home = mkdtempSync(join(tmpdir(), 'hippo-vec-cand-'));
  const global = mkdtempSync(join(tmpdir(), 'hippo-vec-cand-global-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'text-embedding-3-small' } }), 'utf8');
  initStore(home);
  initStore(global);
  const s: Seeded = { home, global, labelById: new Map(), idByLabel: new Map() };
  add(s, 'L1', 'deploy pipeline uses blue green rollout');
  add(s, 'L2', 'deploy checklist says run migrations before every deploy');
  add(s, 'L3', 'rollback the deploy when health checks fail twice');
  add(s, 'L4', 'pipeline caching speeds up the nightly builds');
  add(s, 'S1', 'ship to production with zero downtime');
  add(s, 'S2', 'release trains leave every tuesday morning');
  add(s, 'SC1', 'team alpha ships through its own runner', { scope: 'team:alpha' });
  add(s, 'PR1', 'private channel ships hotfixes directly', { scope: 'slack:private:c1' });
  add(s, 'LG1', 'legacy quarantined shipping notes', { scope: 'unknown:legacy' });
  for (let i = 0; i < 6; i++) add(s, `N${i}`, `unrelated noise row number ${i} about lunch menus`);
  return s;
}

/** The query vector is [1,0,0]: S1 and the scoped rows match it exactly, S2 nearly, lexical rows at 0.6, noise not at all. */
function withEmbeddings(s: Seeded): void {
  const index: Record<string, number[]> = {};
  for (const [label, id] of s.idByLabel) {
    if (label === 'S2') index[id] = [0.9, 0.1, 0];
    else if (['S1', 'SC1', 'PR1', 'LG1'].includes(label)) index[id] = [1, 0, 0];
    else index[id] = label.startsWith('N') ? [0, 0, 1] : [0.6, 0.8, 0];
  }
  saveEmbeddingIndex(s.home, index);
  saveStoredEmbeddingModel(s.home, resolveEmbeddingProvider(s.home).id);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    // SAFETY: body is the OpenAI embeddings request this provider just serialised.
    const body = JSON.parse(init.body) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
  }));
}

const labels = (s: Seeded, ids: readonly string[]): string[] => ids.map((id) => s.labelById.get(id) ?? id);

describe('hybrid recall candidates with stored vectors', () => {
  const dirs: string[] = [];
  const track = (s: Seeded): Seeded => { dirs.push(s.home, s.global); return s; };

  beforeEach(() => {
    process.env.HIPPO_FAKE_NOW = NOW;
    process.env.OPENAI_API_KEY = 'sk-test';
    _resetAblationCacheForTests();
  });

  afterEach(() => {
    delete process.env.HIPPO_FAKE_NOW;
    delete process.env.OPENAI_API_KEY;
    _resetAblationCacheForTests();
    vi.unstubAllGlobals();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('searchBothHybrid default recall', async () => {
    const s = track(seed());
    withEmbeddings(s);
    const res = await searchBothHybrid(QUERY, s.home, s.global, { budget: 100000, tenantId: TENANT, recallScope: {}, scope: null });
    expect(labels(s, res.map((r) => r.entry.id))).toEqual(EXPECTED.sharedDefault);
  });

  it('searchBothHybrid with an explicit additive scope', async () => {
    const s = track(seed());
    withEmbeddings(s);
    const res = await searchBothHybrid(QUERY, s.home, s.global, {
      budget: 100000, tenantId: TENANT, recallScope: { requested: 'team:alpha', additive: true }, scope: null,
    });
    expect(labels(s, res.map((r) => r.entry.id))).toEqual(EXPECTED.sharedAdditive);
  });

  it('api.retrieve in hybrid mode', async () => {
    const s = track(seed());
    withEmbeddings(s);
    const res = await retrieve(
      { hippoRoot: s.home, tenantId: TENANT, actor: { subject: 'cli', role: 'admin' } },
      { query: QUERY, mode: 'hybrid', limit: 20 },
    );
    expect(labels(s, res.results.map((r) => r.id))).toEqual(EXPECTED.retrieveHybrid);
  });

  it('getContext with a query and no global store', async () => {
    const s = track(seed());
    withEmbeddings(s);
    const saved = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = join(s.global, 'absent');
    try {
      const res = await getContext({ hippoRoot: s.home, tenantId: TENANT, actor: { subject: 'cli', role: 'admin' } }, { q: QUERY, budget: 100000 });
      expect(labels(s, res.entries.map((e) => e.entry.id))).toEqual(EXPECTED.contextLocal);
    } finally {
      if (saved === undefined) delete process.env.HIPPO_HOME;
      else process.env.HIPPO_HOME = saved;
    }
  });

  it('without a vector spec, hybridSearch ranks only the pool it was given', async () => {
    const s = track(seed());
    withEmbeddings(s);
    const pool = loadRecallSearchEntries(s.home, QUERY, undefined, TENANT, undefined, 'additive', false);
    const res = await hybridSearch(QUERY, pool, { budget: 100000, hippoRoot: s.home, scope: null });
    expect(labels(s, res.map((r) => r.entry.id))).toEqual(EXPECTED.plainPool);
  });
});

// S1, S2 and SC1 share no word with the query and arrive through the vector arm; PR1 and LG1 never do.
const LEXICAL = ['L1', 'L4', 'L2', 'L3'];
const WITH_VECTORS = ['L1', 'S1', 'SC1', 'S2', 'L2', 'L4', 'L3'];
const EXPECTED = {
  sharedDefault: WITH_VECTORS,
  sharedAdditive: WITH_VECTORS,
  retrieveHybrid: WITH_VECTORS,
  contextLocal: WITH_VECTORS,
  plainPool: LEXICAL,
};
