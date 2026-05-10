import { describe, it, expect } from 'vitest';
import { hybridSearch, type SearchResult } from '../../src/search.js';
import { createMemory } from '../../src/memory.js';
import type { RerankerFn } from '../../src/rerankers/types.js';

describe('hybridSearch reranker seam', () => {
  it('invokes the reranker after MMR and before budget filtering', async () => {
    // All three entries share the term "failure" so each survives BM25
    // pre-filtering and reaches the reranker — letting us prove that the
    // reranker's output ordering, not the pre-rerank ordering, drives the
    // final result list.
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
      // Reverse order to prove the reranker output replaces the input ordering
      return [...results].reverse().map((r, i) => ({
        ...r,
        rerankScore: results.length - i,
      }));
    };

    const out = await hybridSearch('failure', entries, {
      budget: 100000,
      reranker: stub,
    });

    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe('failure');
    expect(calls[0].resultCount).toBe(3);
    // Reranker output ordering is preserved: the entry that was LAST in the
    // reranker's input comes out FIRST, proving the reranker's ordering
    // replaces the pre-rerank ordering rather than being merged with it.
    expect(out[0].entry.id).toBe(lastInputId);
    expect(out[0].rerankScore).toBeDefined();
    expect(out[0].postRerankRank).toBe(1);
  });

  it('skips reranker when option not provided (current behaviour preserved)', async () => {
    const entries = [createMemory('the quick brown fox')];
    const out = await hybridSearch('fox', entries, { budget: 100000 });
    expect(out.length).toBe(1);
    expect(out[0]).not.toHaveProperty('rerankScore');
  });
});
