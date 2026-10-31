/**
 * Tests for hybrid search: BM25 + embedding vector blending.
 * Uses synthetic vectors (no Transformers.js backend needed).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { hybridSearch } from '../src/search/hybrid.js';
import { search } from '../src/search/bm25-search.js';
import { mmrRerank } from '../src/search/rerank.js';
import type { SearchResult } from '../src/core/search-types.js';
import { createMemory, applyOutcome, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import { embeddingIndexIdentity } from '../src/store/embeddings/index.js';
import { initStore } from '../src/store/open.js';
import { closeHippoDb, openHippoDb, setMeta } from '../src/db/index.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../src/db/vector-store.js';
import { HASHED_DIM, hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL = 'hashed-16';
const IDENTITY = embeddingIndexIdentity(`openai:${MODEL}`);
let embeddings: HashedEmbeddings;
const roots: string[] = [];

/** A real store whose provider is the local hashed-embedding server, holding exactly `vectors`. */
function vectorRoot(vectors: Record<string, readonly number[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hybrid-'));
  roots.push(root);
  initStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: MODEL, apiBaseUrl: embeddings.url } }));
  const db = openHippoDb(root);
  try {
    setMeta(db, EMBEDDING_MODEL_META_KEY, IDENTITY);
    upsertVectors(db, Object.entries(vectors), IDENTITY);
  } finally {
    closeHippoDb(db);
  }
  return root;
}

/** `count` unit vectors orthogonal to `q` and to each other, so a test sets each cosine exactly. */
function orthogonalTo(q: readonly number[], count: number): number[][] {
  const basis = [[...q]];
  for (let k = 0; basis.length <= count; k++) {
    let v = Array.from({ length: HASHED_DIM }, (_, i): number => (i === k ? 1 : 0));
    for (const b of basis) {
      const d = v.reduce((sum, x, i) => sum + x * b[i]!, 0);
      v = v.map((x, i) => x - d * b[i]!);
    }
    const norm = Math.hypot(...v);
    if (norm > 1e-6) basis.push(v.map((x) => x / norm));
  }
  return basis.slice(1);
}

/** The unit vector whose cosine with unit `q` is `cos`, leaning toward the unit `away` orthogonal to it. */
function withCosine(q: readonly number[], away: readonly number[], cos: number): number[] {
  const sin = Math.sqrt(1 - cos * cos);
  return q.map((x, i) => cos * x + sin * away[i]!);
}

const memory = (content: string): MemoryEntry => createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });

beforeAll(async () => { embeddings = await startHashedEmbeddings(); });
afterAll(async () => {
  await embeddings.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hybrid scoring tests (with synthetic embeddings)
// ---------------------------------------------------------------------------

describe('hybridSearch over stored vectors', () => {
  beforeEach(() => { vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('finds a row no query word matches through its stored vector alone', async () => {
    const query = 'deployment broke';
    const q = hashedVector(query);
    const [near, far] = orthogonalTo(q, 2);
    const related = memory('CI pipeline failure on push to master causes rollback');
    const unrelated = memory('Python dict ordering is guaranteed in 3.7+');
    const root = vectorRoot({ [related.id]: withCosine(q, near!, 0.95), [unrelated.id]: withCosine(q, far!, -0.1) });

    expect(await hybridSearch(query, [related, unrelated], { budget: 10_000 })).toEqual([]);
    const results = await hybridSearch(query, [related, unrelated], { hippoRoot: root, budget: 10_000, scope: null, explain: true });
    expect(results.map((r) => r.entry.id)).toEqual([related.id]);
    expect(results[0]!.bm25).toBe(0);
    expect(results[0]!.cosine).toBeCloseTo(0.95, 5);
    expect(results[0]!.breakdown?.mode).toBe('hybrid');
  });

  it('blends normalised BM25 and cosine by embeddingWeight, 0.6 to cosine by default', async () => {
    const query = 'cache failure';
    const q = hashedVector(query);
    const [a, b] = orthogonalTo(q, 2);
    const keyword = memory('cache failure: the cache failure repeats on every cache failure');
    const semantic = memory('the cache went stale overnight');
    const root = vectorRoot({ [keyword.id]: withCosine(q, a!, 0.1), [semantic.id]: withCosine(q, b!, 0.9) });
    const run = (embeddingWeight?: number) =>
      hybridSearch(query, [keyword, semantic], { hippoRoot: root, budget: 10_000, scope: null, explain: true, embeddingWeight });

    for (const [weight, expected] of [[undefined, 0.6], [0.1, 0.1], [0.9, 0.9]] as const) {
      const results = await run(weight);
      expect(results.map((r) => r.cosine).sort()).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.9, 5)]);
      for (const r of results) {
        const bd = r.breakdown!;
        expect(bd.embeddingWeight).toBe(expected);
        expect(bd.bm25Weight).toBeCloseTo(1 - expected, 12);
        expect(bd.base).toBeCloseTo((1 - expected) * bd.normBm25 + expected * r.cosine, 9);
      }
    }
    expect((await run(0.1)).map((r) => r.entry.id)).toEqual([keyword.id, semantic.id]);
    expect((await run(0.9)).map((r) => r.entry.id)).toEqual([semantic.id, keyword.id]);
  });
});

describe('hybridSearch with embeddings', () => {
  it('falls back to BM25-only when no embedding index exists', async () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        tags: ['error', 'data-pipeline'],
      }),
      createMemory('Python dict ordering is guaranteed in 3.7+', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        tags: ['python'],
      }),
    ];

    // hybridSearch without hippoRoot falls back to BM25
    const results = await hybridSearch('FRED cache failure', entries, { budget: 10000 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toMatch(/FRED|cache/i);
  });

  it('respects token budget in hybrid mode', async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      createMemory('cache error in data pipeline refresh ' + 'x'.repeat(200) + ` entry${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS })
    );

    const results = await hybridSearch('cache error', entries, { budget: 300 });
    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(300);
  });

  it('embeddingWeight=0 produces same ranking as pure BM25', async () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      createMemory('Always verify cache contents after refresh failures', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      createMemory('Python dict ordering is guaranteed in 3.7+', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    ];

    const bm25Results = search('cache failure', entries, { budget: 10000 });
    const hybridResults = await hybridSearch('cache failure', entries, {
      budget: 10000,
      embeddingWeight: 0,
    });

    // Same number of results, same order
    expect(hybridResults.length).toBe(bm25Results.length);
    for (let i = 0; i < bm25Results.length; i++) {
      expect(hybridResults[i].entry.id).toBe(bm25Results[i].entry.id);
    }
  });

  it('returns empty for empty query', async () => {
    const entries = [createMemory('some content', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS })];
    const results = await hybridSearch('', entries, { budget: 10000 });
    expect(results.length).toBe(0);
  });

  it('returns empty for empty entries', async () => {
    const results = await hybridSearch('cache failure', [], { budget: 10000 });
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// explain: score breakdown
// ---------------------------------------------------------------------------

describe('hybridSearch explain breakdown', () => {
  it('omits breakdown when explain flag is not set', async () => {
    const entries = [createMemory('FRED cache silently dropped the TIPS series', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS })];
    const results = await hybridSearch('FRED cache', entries, { budget: 10000 });
    expect(results.length).toBe(1);
    expect(results[0].breakdown).toBeUndefined();
  });

  it('populates breakdown when explain=true', async () => {
    const entries = [createMemory('FRED cache silently dropped the TIPS series', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS })];
    const results = await hybridSearch('FRED cache failure', entries, {
      budget: 10000,
      explain: true,
    });
    expect(results.length).toBe(1);
    const b = results[0].breakdown;
    expect(b).toBeDefined();
    if (!b) return;
    // In a test env without a Transformers.js backend the embedding path is off
    // and the mode falls through to bm25-only. The hybrid-no-vec case needs
    // a mocked embedding pipeline and is verified via live dogfooding.
    expect(b.mode).toBe('bm25-only');
    expect(b.matchedTerms).toEqual(expect.arrayContaining(['fred', 'cache']));
    expect(b.strengthMultiplier).toBeGreaterThanOrEqual(0.5);
    expect(b.strengthMultiplier).toBeLessThanOrEqual(1);
    expect(b.recencyMultiplier).toBeGreaterThanOrEqual(0.8);
    expect(b.recencyMultiplier).toBeLessThanOrEqual(1);
    expect(b.decisionBoost).toBe(1);
    expect(b.ageDays).toBeGreaterThanOrEqual(0);
  });

  it('final equals base * multipliers within rounding tolerance', async () => {
    const entries = [
      createMemory('cache refresh verify contents after failure', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      createMemory('Python dict ordering is guaranteed in 3.7+', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    ];
    const results = await hybridSearch('cache failure', entries, {
      budget: 10000,
      explain: true,
    });
    for (const r of results) {
      const b = r.breakdown;
      expect(b).toBeDefined();
      if (!b) continue;
      const expected =
        b.base
        * b.strengthMultiplier
        * b.recencyMultiplier
        * b.decisionBoost
        * b.pathBoost
        * b.sourceBump
        * b.outcomeBoost;
      expect(b.final).toBeCloseTo(expected, 5);
      expect(r.score).toBeCloseTo(b.final, 5);
      expect(b.sourceBump).toBe(1);
      // Fresh memories have no outcome signal → boost should be exactly 1.
      expect(b.outcomeBoost).toBe(1);
    }
  });

  it('applies 1.2x decision boost for decision-tagged memories', async () => {
    const normal = createMemory('always verify cache after refresh', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const decided = createMemory('decide to always verify cache after refresh', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['decision'],
    });
    const entries = [normal, decided];
    const results = await hybridSearch('verify cache', entries, {
      budget: 10000,
      explain: true,
    });
    const decidedResult = results.find((r) => r.entry.id === decided.id);
    const normalResult = results.find((r) => r.entry.id === normal.id);
    expect(decidedResult?.breakdown?.decisionBoost).toBe(1.2);
    expect(normalResult?.breakdown?.decisionBoost).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SearchResult.cosine field
// ---------------------------------------------------------------------------

describe('SearchResult cosine field', () => {
  it('search() returns cosine=0 (no embedding path)', () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    ];
    const results = search('FRED cache', entries, { budget: 10000 });
    expect(results.length).toBe(1);
    expect(results[0].cosine).toBe(0);
  });

  it('hybridSearch() returns cosine=0 when embeddings unavailable', async () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    ];
    const results = await hybridSearch('FRED cache', entries, { budget: 10000 });
    expect(results.length).toBe(1);
    expect(results[0].cosine).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchBoth hybrid support
// ---------------------------------------------------------------------------

describe('searchBothHybrid', () => {
  it('is exported and callable', async () => {
    const { searchBothHybrid } = await import('../src/sharing/search-both.js');
    expect(searchBothHybrid).toBeInstanceOf(Function);
  });
});

// ---------------------------------------------------------------------------
// outcomeBoost: retrieval-time personalization
// ---------------------------------------------------------------------------

describe('outcomeBoost', () => {
  it('fresh memory with no outcome signal has boost = 1', async () => {
    const entries = [createMemory('FRED cache silently dropped TIPS', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS })];
    const results = await hybridSearch('FRED cache', entries, {
      budget: 10000,
      explain: true,
    });
    expect(results[0].breakdown?.outcomeBoost).toBe(1);
  });

  it('positive outcomes push boost above 1 (up to 1.15)', async () => {
    let m = createMemory('FRED cache silently dropped TIPS', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, true);
    m = applyOutcome(m, true);
    m = applyOutcome(m, true);
    const results = await hybridSearch('FRED cache', [m], {
      budget: 10000,
      explain: true,
    });
    const boost = results[0].breakdown?.outcomeBoost ?? 0;
    expect(boost).toBeGreaterThan(1);
    expect(boost).toBeLessThanOrEqual(1.15);
  });

  it('negative outcomes push boost below 1 (down to 0.85)', async () => {
    let m = createMemory('FRED cache silently dropped TIPS', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, false);
    m = applyOutcome(m, false);
    m = applyOutcome(m, false);
    const results = await hybridSearch('FRED cache', [m], {
      budget: 10000,
      explain: true,
    });
    const boost = results[0].breakdown?.outcomeBoost ?? 0;
    expect(boost).toBeLessThan(1);
    expect(boost).toBeGreaterThanOrEqual(0.85);
  });

  it('positive outcomes outrank neutral peers with identical text', async () => {
    const a = createMemory('cache refresh verify contents after failure', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    let b = createMemory('cache refresh verify contents after failure', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    b = applyOutcome(b, true);
    b = applyOutcome(b, true);
    const results = await hybridSearch('cache failure', [a, b], {
      budget: 10000,
      explain: true,
    });
    expect(results[0].entry.id).toBe(b.id);
    expect(results[1].entry.id).toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// MMR re-ranking
// ---------------------------------------------------------------------------

describe('mmrRerank', () => {
  function makeResult(id: string, score: number): SearchResult {
    return {
      entry: createMemory('placeholder', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: [] }),
      score,
      bm25: 0,
      cosine: 0,
      tokens: 0,
      // force id to match what we index in embeddings map
    };
  }

  it('lambda=1 returns pure-relevance ordering unchanged', () => {
    const a = makeResult('a', 0.9);
    const b = makeResult('b', 0.6);
    a.entry.id = 'a';
    b.entry.id = 'b';
    const idx = { a: [1, 0], b: [0, 1] };
    const ranked = mmrRerank([a, b], idx, 1.0, false);
    expect(ranked.map((r) => r.entry.id)).toEqual(['a', 'b']);
  });

  it('de-clusters near-duplicates at lambda=0.5', () => {
    // a and b are near-duplicates; c is diverse. MMR should prefer c over b
    // for the second slot even though b has the higher raw score.
    const a = makeResult('a', 1.00);
    const b = makeResult('b', 0.95);
    const c = makeResult('c', 0.70);
    a.entry.id = 'a';
    b.entry.id = 'b';
    c.entry.id = 'c';
    const idx = {
      a: [1, 0, 0],
      b: [0.99, 0.14, 0],     // cos(a, b) ≈ 0.99 — duplicates
      c: [0, 0, 1],            // orthogonal — diverse
    };
    const ranked = mmrRerank([a, b, c], idx, 0.5, false);
    expect(ranked[0].entry.id).toBe('a');
    expect(ranked[1].entry.id).toBe('c');    // diversity wins over raw rank
    expect(ranked[2].entry.id).toBe('b');
  });

  it('attaches pre/post MMR ranks to breakdowns when explain=true', () => {
    const a = makeResult('a', 1.00);
    const b = makeResult('b', 0.95);
    const c = makeResult('c', 0.70);
    a.entry.id = 'a';
    b.entry.id = 'b';
    c.entry.id = 'c';
    // SAFETY: fixture only reads breakdown.mode/preMmrRank/postMmrRank below;
    // mmrRerank sets the MMR rank fields, the rest of ScoreBreakdown is unused here.
    a.breakdown = { mode: 'hybrid' } as SearchResult['breakdown'];
    // SAFETY: fixture only reads breakdown.mode/preMmrRank/postMmrRank below;
    // mmrRerank sets the MMR rank fields, the rest of ScoreBreakdown is unused here.
    b.breakdown = { mode: 'hybrid' } as SearchResult['breakdown'];
    // SAFETY: fixture only reads breakdown.mode/preMmrRank/postMmrRank below;
    // mmrRerank sets the MMR rank fields, the rest of ScoreBreakdown is unused here.
    c.breakdown = { mode: 'hybrid' } as SearchResult['breakdown'];
    const idx = { a: [1, 0, 0], b: [0.99, 0.14, 0], c: [0, 0, 1] };
    const ranked = mmrRerank([a, b, c], idx, 0.5, true);
    expect(ranked[0].breakdown?.preMmrRank).toBe(1);
    expect(ranked[0].breakdown?.postMmrRank).toBe(1);
    expect(ranked[1].breakdown?.preMmrRank).toBe(3);   // c was 3rd by relevance
    expect(ranked[1].breakdown?.postMmrRank).toBe(2);  // now 2nd after MMR
  });

  it('leaves order unchanged when no embeddings are available for any doc', () => {
    const a = makeResult('a', 0.9);
    const b = makeResult('b', 0.8);
    a.entry.id = 'a';
    b.entry.id = 'b';
    const ranked = mmrRerank([a, b], {}, 0.5, false);
    expect(ranked.map((r) => r.entry.id)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// MMR candidate cap — regression guard on the O(N^2) blowup that was
// making recall on large stores take 50s+ per query.
// ---------------------------------------------------------------------------

describe('hybridSearch MMR cap on large candidate sets', () => {
  beforeEach(() => { vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('re-ranks only the top 100 by relevance and keeps the rest in relevance order', async () => {
    const query = 'topic content about';
    const q = hashedVector(query);
    const [cluster, headAway, tailAway] = orthogonalTo(q, 3);
    // Every row has the same words, so BM25 ties and each row's stored cosine alone sets its relevance rank.
    const entries = Array.from({ length: 150 }, (_, i) => memory(`topic ${String(i).padStart(3, '0')} about content`));
    const HEAD_OUTLIER = 50;
    const TAIL_OUTLIER = 149;
    const vectors = Object.fromEntries(entries.map((e, i) => {
      const away = i === HEAD_OUTLIER ? headAway! : i === TAIL_OUTLIER ? tailAway! : cluster!;
      return [e.id, withCosine(q, away, i === TAIL_OUTLIER ? 0.5 : 0.99 - i * 0.001)];
    }));

    const results = await hybridSearch(query, entries, { hippoRoot: vectorRoot(vectors), budget: 1_000_000, scope: null, explain: true, mmrLambda: 0.5 });

    expect(results).toHaveLength(150);
    expect(results.filter((r) => r.breakdown?.preMmrRank !== undefined)).toHaveLength(100);
    // The head outlier proves MMR ran: off the cluster, it jumps the near-duplicates ranked above it.
    const head = results.find((r) => r.entry.id === entries[HEAD_OUTLIER]!.id)!.breakdown!;
    expect(head.postMmrRank!).toBeLessThan(head.preMmrRank!);
    // The tail outlier would jump them too, but past the cap it keeps its last place.
    expect(results.slice(100).map((r) => r.entry.id)).toEqual(entries.slice(100).map((e) => e.id));
  });
});

describe('hybridSearch minResults', () => {
  it('returns at least minResults entries even when budget is tight', async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      createMemory(`important topic ${i} with enough content to exceed a small budget ${'x'.repeat(200)}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    );
    const withMin = await hybridSearch('important topic', entries, {
      budget: 100,
      minResults: 5,
    });
    const withoutMin = await hybridSearch('important topic', entries, {
      budget: 100,
    });
    expect(withMin.length).toBeGreaterThanOrEqual(5);
    expect(withoutMin.length).toBeLessThan(withMin.length);
  });

  it('does not exceed available results when minResults is higher', async () => {
    const entries = [createMemory('solo topic about something unique', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS })];
    const results = await hybridSearch('solo topic', entries, {
      budget: 100,
      minResults: 10,
    });
    expect(results.length).toBe(1);
  });
});
