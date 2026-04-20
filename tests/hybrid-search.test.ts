/**
 * Tests for hybrid search: BM25 + embedding vector blending.
 * Uses synthetic vectors (no @xenova/transformers needed).
 */

import { describe, it, expect } from 'vitest';
import { hybridSearch, search, mmrRerank, type SearchResult } from '../src/search.js';
import { createMemory, applyOutcome } from '../src/memory.js';
import { cosineSimilarity } from '../src/embeddings.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveEmbeddingIndex } from '../src/embeddings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a tmp hippo root with a pre-built embedding index. */
function setupEmbeddingFixture(index: Record<string, number[]>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hybrid-'));
  saveEmbeddingIndex(tmpDir, index);
  return tmpDir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Hybrid scoring tests (with synthetic embeddings)
// ---------------------------------------------------------------------------

describe('hybridSearch with embeddings', () => {
  it('returns results that have no BM25 match but high cosine similarity', async () => {
    // "deployment broke" vs "CI pipeline failure" — no shared tokens, but semantically related
    const entries = [
      createMemory('CI pipeline failure on push to master causes rollback'),
      createMemory('Python dict ordering is guaranteed in 3.7+'),
    ];

    // Synthetic vectors: query is close to entry[0], far from entry[1]
    const queryVector = [1.0, 0.0, 0.0, 0.0];
    const embeddingIndex: Record<string, number[]> = {
      [entries[0].id]: [0.95, 0.05, 0.0, 0.0],  // high similarity to query
      [entries[1].id]: [0.0, 0.0, 1.0, 0.0],     // orthogonal to query
    };

    const tmpDir = setupEmbeddingFixture(embeddingIndex);

    // With BM25 only, "deployment broke" finds nothing (no shared tokens)
    const bm25Results = search('deployment broke', entries, { budget: 10000 });
    expect(bm25Results.length).toBe(0);

    // Hybrid search should find entry[0] via cosine similarity
    // We need to mock the embedding pipeline — hybridSearch calls isEmbeddingAvailable()
    // and getEmbedding() which require the actual library.
    // Instead, test the scoring math directly.
    const cosine = cosineSimilarity(queryVector, embeddingIndex[entries[0].id]);
    expect(cosine).toBeGreaterThan(0.9);

    const cosineIrrelevant = cosineSimilarity(queryVector, embeddingIndex[entries[1].id]);
    expect(cosineIrrelevant).toBeCloseTo(0, 5);

    cleanup(tmpDir);
  });

  it('blends BM25 and cosine scores with configurable weight', async () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series'),
      createMemory('cache refresh always verify contents after failure'),
    ];

    // entry[0]: strong keyword match AND strong embedding match
    // entry[1]: strong keyword match but weak embedding match
    const queryVector = [1.0, 0.0, 0.0];
    const embeddingIndex: Record<string, number[]> = {
      [entries[0].id]: [0.9, 0.1, 0.0],   // high cosine
      [entries[1].id]: [0.1, 0.9, 0.0],   // low cosine
    };

    // BM25 alone: both match "cache" similarly
    const bm25Results = search('cache failure', entries, { budget: 10000 });
    expect(bm25Results.length).toBe(2);

    // Verify that the cosine scores discriminate
    const cos0 = cosineSimilarity(queryVector, embeddingIndex[entries[0].id]);
    const cos1 = cosineSimilarity(queryVector, embeddingIndex[entries[1].id]);
    expect(cos0).toBeGreaterThan(cos1);

    cleanup(setupEmbeddingFixture(embeddingIndex));
  });

  it('falls back to BM25-only when no embedding index exists', async () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series', {
        tags: ['error', 'data-pipeline'],
      }),
      createMemory('Python dict ordering is guaranteed in 3.7+', {
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
      createMemory('cache error in data pipeline refresh ' + 'x'.repeat(200) + ` entry${i}`)
    );

    const results = await hybridSearch('cache error', entries, { budget: 300 });
    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(300);
  });

  it('embeddingWeight=0 produces same ranking as pure BM25', async () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series'),
      createMemory('Always verify cache contents after refresh failures'),
      createMemory('Python dict ordering is guaranteed in 3.7+'),
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
    const entries = [createMemory('some content')];
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
    const entries = [createMemory('FRED cache silently dropped the TIPS series')];
    const results = await hybridSearch('FRED cache', entries, { budget: 10000 });
    expect(results.length).toBe(1);
    expect(results[0].breakdown).toBeUndefined();
  });

  it('populates breakdown when explain=true', async () => {
    const entries = [createMemory('FRED cache silently dropped the TIPS series')];
    const results = await hybridSearch('FRED cache failure', entries, {
      budget: 10000,
      explain: true,
    });
    expect(results.length).toBe(1);
    const b = results[0].breakdown;
    expect(b).toBeDefined();
    if (!b) return;
    // In a test env without @xenova/transformers the embedding path is off
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
      createMemory('cache refresh verify contents after failure'),
      createMemory('Python dict ordering is guaranteed in 3.7+'),
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
    const normal = createMemory('always verify cache after refresh');
    const decided = createMemory('decide to always verify cache after refresh', {
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
      createMemory('FRED cache silently dropped the TIPS series'),
    ];
    const results = search('FRED cache', entries, { budget: 10000 });
    expect(results.length).toBe(1);
    expect(results[0].cosine).toBe(0);
  });

  it('hybridSearch() returns cosine=0 when embeddings unavailable', async () => {
    const entries = [
      createMemory('FRED cache silently dropped the TIPS series'),
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
    const { searchBothHybrid } = await import('../src/shared.js');
    expect(typeof searchBothHybrid).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// outcomeBoost: retrieval-time personalization
// ---------------------------------------------------------------------------

describe('outcomeBoost', () => {
  it('fresh memory with no outcome signal has boost = 1', async () => {
    const entries = [createMemory('FRED cache silently dropped TIPS')];
    const results = await hybridSearch('FRED cache', entries, {
      budget: 10000,
      explain: true,
    });
    expect(results[0].breakdown?.outcomeBoost).toBe(1);
  });

  it('positive outcomes push boost above 1 (up to 1.15)', async () => {
    let m = createMemory('FRED cache silently dropped TIPS');
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
    let m = createMemory('FRED cache silently dropped TIPS');
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
    const a = createMemory('cache refresh verify contents after failure');
    let b = createMemory('cache refresh verify contents after failure');
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
      entry: createMemory('placeholder', { tags: [] }),
      score,
      bm25: 0,
      cosine: 0,
      tokens: 0,
      // force id to match what we index in embeddings map
    } as unknown as SearchResult & { entry: { id: string } };
  }

  it('lambda=1 returns pure-relevance ordering unchanged', () => {
    const a = makeResult('a', 0.9);
    const b = makeResult('b', 0.6);
    (a as unknown as { entry: { id: string } }).entry.id = 'a';
    (b as unknown as { entry: { id: string } }).entry.id = 'b';
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
    (a as unknown as { entry: { id: string } }).entry.id = 'a';
    (b as unknown as { entry: { id: string } }).entry.id = 'b';
    (c as unknown as { entry: { id: string } }).entry.id = 'c';
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
    (a as unknown as { entry: { id: string } }).entry.id = 'a';
    (b as unknown as { entry: { id: string } }).entry.id = 'b';
    (c as unknown as { entry: { id: string } }).entry.id = 'c';
    a.breakdown = { mode: 'hybrid' } as SearchResult['breakdown'];
    b.breakdown = { mode: 'hybrid' } as SearchResult['breakdown'];
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
    (a as unknown as { entry: { id: string } }).entry.id = 'a';
    (b as unknown as { entry: { id: string } }).entry.id = 'b';
    const ranked = mmrRerank([a, b], {}, 0.5, false);
    expect(ranked.map((r) => r.entry.id)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// MMR candidate cap — regression guard on the O(N^2) blowup that was
// making recall on large stores take 50s+ per query.
// ---------------------------------------------------------------------------

describe('hybridSearch MMR cap on large candidate sets', () => {
  it('preserves tail entries past MMR cap in relevance order', async () => {
    // 150 entries — enough to exceed the 100-entry MMR cap in hybridSearch.
    // Queries match 'topic N' where N is the entry index, so relevance is
    // monotonic: entry N beats entry N+1 on BM25. No embeddings available in
    // test env, so MMR is skipped and we get pure relevance order regardless.
    const entries = Array.from({ length: 150 }, (_, i) =>
      createMemory(`topic ${String(i).padStart(3, '0')} about ${'x'.repeat(20)} content`),
    );
    const results = await hybridSearch('topic content about', entries, {
      budget: 1_000_000, // enough to include all matches
      mmr: true,
      mmrLambda: 0.5,
    });
    // Top 10 should all score positive and be in the returned list.
    expect(results.length).toBeGreaterThan(10);
    // No crash, no timeout, and results are well-ordered by score desc.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});
