import { describe, it, expect } from 'vitest';
import { hybridSearch } from '../../src/entry/folder-search.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { RerankerFn } from '../../src/base/ports/reranker.js';

describe('hybridSearch reranker seam', () => {
  it('invokes the reranker after MMR and before budget filtering', async () => {
    const entries = [
      createMemory('CI pipeline failure on push to master'),
      createMemory('Python dict ordering failure in 3.7+'),
      createMemory('Production database failure in us-east-1'),
    ];

    const calls: { query: string; resultCount: number }[] = [];
    let lastInputId: string | undefined;
    const stub: RerankerFn = async (query, results) => {
      calls.push({ query, resultCount: results.length });
      lastInputId = results[results.length - 1].entry.id;
      return results
        .map((r, i) => ({ ...r, preRerankRank: i + 1 }))
        .reverse()
        .map((r, i) => ({ ...r, rerankScore: results.length - i, postRerankRank: i + 1 }));
    };

    const out = await hybridSearch('failure', entries, {
      budget: 100000,
      reranker: stub,
    });

    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe('failure');
    expect(calls[0].resultCount).toBe(3);
    expect(out[0].entry.id).toBe(lastInputId);
    expect(out[0].rerankScore).toBe(3);
    expect(out[0].postRerankRank).toBe(1);
  });

  it('passes its topK to the reranker, so a smaller reranker default drops nothing', async () => {
    const entries = ['alpha failure', 'beta failure', 'gamma failure', 'delta failure'].map((c) => createMemory(c));
    const stub: RerankerFn = async (_query, results, options) =>
      results
        .slice(0, options?.topK ?? 2)
        .map((r, i) => ({ ...r, rerankScore: r.score, preRerankRank: i + 1, postRerankRank: i + 1 }));
    const out = await hybridSearch('failure', entries, { budget: 100000, reranker: stub });
    expect(out).toHaveLength(4);
  });

  it('skips reranker when option not provided (current behaviour preserved)', async () => {
    const entries = [createMemory('the quick brown fox')];
    const out = await hybridSearch('fox', entries, { budget: 100000 });
    expect(out.length).toBe(1);
    expect(out[0]).not.toHaveProperty('rerankScore');
  });
});
