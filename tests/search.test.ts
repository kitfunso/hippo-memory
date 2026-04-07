import { describe, it, expect } from 'vitest';
import { search, markRetrieved, estimateTokens, textOverlap } from '../src/search.js';
import { createMemory, Layer } from '../src/memory.js';

function makeEntries() {
  return [
    createMemory('FRED cache silently dropped the TIPS series during daily refresh', {
      tags: ['error', 'data-pipeline'],
    }),
    createMemory('Gold model uses TIPS 10y as primary inflation signal', {
      tags: ['model', 'gold'],
    }),
    createMemory('Always verify cache contents after refresh failures', {
      tags: ['error'],
    }),
    createMemory('Equities tend to rally in Q4 due to tax-loss harvesting reversal', {
      tags: ['equities'],
    }),
    createMemory('Python dict ordering is guaranteed in 3.7+', {
      tags: ['python'],
    }),
  ];
}

describe('BM25 search', () => {
  it('returns the most relevant result for a cache-related query', () => {
    const entries = makeEntries();
    const results = search('FRED cache failure', entries, { budget: 10000 });

    expect(results.length).toBeGreaterThan(0);
    // Top result should be about FRED/cache
    expect(results[0].entry.content.toLowerCase()).toMatch(/fred|cache/);
  });

  it('returns empty results for a query with no matching tokens', () => {
    const entries = makeEntries();
    const results = search('xyzzy qwerty foobar', entries);
    expect(results.length).toBe(0);
  });

  it('sorts results by composite score descending', () => {
    const entries = makeEntries();
    const results = search('error cache refresh', entries, { budget: 10000 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('respects token budget', () => {
    // Create many entries with known token sizes
    const bigEntries = Array.from({ length: 20 }, (_, i) =>
      createMemory('cache error in data pipeline refresh ' + 'x'.repeat(200) + ` entry${i}`)
    );

    const results = search('cache error', bigEntries, { budget: 300 });
    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(300);
  });

  it('prefers higher-strength entries when BM25 scores are similar', () => {
    const now = new Date();
    const recentDate = now.toISOString();
    const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const strong = createMemory('cache refresh data pipeline issue');
    const weak = createMemory('cache refresh data pipeline issue');

    const e1 = { ...strong, last_retrieved: recentDate, retrieval_count: 10 };
    const e2 = { ...weak, last_retrieved: oldDate, retrieval_count: 0 };

    const results = search('cache refresh', [e1, e2], { budget: 10000 });
    expect(results.length).toBe(2);
    // Strong entry should rank higher
    expect(results[0].entry.id).toBe(e1.id);
  });
});

describe('estimateTokens', () => {
  it('estimates ~1 token per 4 chars', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('rounds up', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('textOverlap (Jaccard)', () => {
  it('returns 1.0 for identical strings', () => {
    expect(textOverlap('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 0 for completely different strings', () => {
    expect(textOverlap('apple banana cherry', 'xyz foobar qux')).toBe(0);
  });

  it('returns partial overlap for related strings', () => {
    const o = textOverlap('cache error in pipeline', 'pipeline cache failure');
    expect(o).toBeGreaterThan(0);
    expect(o).toBeLessThan(1);
  });
});

describe('decision recall boost', () => {
  it('decision-tagged memories get a 1.2x recall boost', () => {
    const decision = createMemory('PostgreSQL is the standard database for all services', {
      tags: ['decision', 'database'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'decision',
    });
    // Give it a longer half-life typical for decisions
    decision.half_life_days = 90;

    const normal = createMemory('PostgreSQL connection pool maximum is set to 20', {
      tags: ['database'],
    });

    const results = search('PostgreSQL database', [decision, normal], { budget: 4000 });

    expect(results.length).toBe(2);
    expect(results[0].entry.tags).toContain('decision');
  });

  it('decision boost applies as a 1.2x multiplier to composite score', () => {
    // Use tags that don't overlap with the query so BM25 stays identical
    const withDecision = createMemory('cache refresh data pipeline issue', {
      tags: ['decision', 'ops'],
    });
    const without = createMemory('cache refresh data pipeline issue', {
      tags: ['ops'],
    });

    // Query only on content terms, not on tag terms
    const results = search('cache refresh', [withDecision, without], { budget: 4000 });

    expect(results.length).toBe(2);
    const decisionResult = results.find(r => r.entry.tags.includes('decision'))!;
    const normalResult = results.find(r => !r.entry.tags.includes('decision'))!;
    // The decision tag adds "decision" to the BM25 doc text which slightly affects
    // corpus stats, so we check a looser tolerance
    expect(decisionResult.score).toBeGreaterThan(normalResult.score);
    // Ratio should be approximately 1.2 (within 10% tolerance)
    expect(decisionResult.score / normalResult.score).toBeGreaterThan(1.1);
    expect(decisionResult.score / normalResult.score).toBeLessThan(1.3);
  });
});

describe('markRetrieved', () => {
  it('increments retrieval_count and updates last_retrieved', () => {
    const entry = createMemory('test memory');
    const before = entry.retrieval_count;
    const now = new Date();

    const [updated] = markRetrieved([entry], now);
    expect(updated.retrieval_count).toBe(before + 1);
    expect(updated.last_retrieved).toBe(now.toISOString());
  });

  it('extends half-life by 2 days per retrieval', () => {
    const entry = createMemory('test memory');
    const beforeHL = entry.half_life_days;
    const [updated] = markRetrieved([entry]);
    expect(updated.half_life_days).toBe(beforeHL + 2);
  });

  it('wakes stale memories back to observed on retrieval', () => {
    const entry = createMemory('old memory', { confidence: 'observed' });
    const stale = { ...entry, confidence: 'stale' as const };

    const [updated] = markRetrieved([stale]);
    expect(updated.confidence).toBe('observed');
  });
});
