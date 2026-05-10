import { describe, it, expect } from 'vitest';
import { featuresReranker } from '../../src/rerankers/features.js';
import { createMemory, type MemoryEntry } from '../../src/memory.js';
import type { SearchResult } from '../../src/search.js';

function asResult(entry: MemoryEntry, score: number): SearchResult {
  return { entry, score, bm25: score, cosine: 0, tokens: 10 };
}

describe('featuresReranker', () => {
  it('boosts verified over inferred when content is otherwise equivalent', async () => {
    const verified = createMemory('Production DB is on us-east-1');
    verified.confidence = 'verified';
    const inferred = createMemory('Production DB is on us-east-1');
    inferred.confidence = 'inferred';

    const out = await featuresReranker(
      'where is the production database',
      [asResult(inferred, 1.0), asResult(verified, 0.99)],
    );

    expect(out[0].entry.id).toBe(verified.id);
    expect(out[0].rerankScore).toBeGreaterThan(out[1].rerankScore);
  });

  it('downweights stale/superseded kinds', async () => {
    const fresh = createMemory('Use OAuth 2.0 for auth');
    fresh.kind = 'distilled';
    const stale = createMemory('Use OAuth 1.0 for auth');
    stale.kind = 'superseded';

    const out = await featuresReranker(
      'how do we authenticate',
      [asResult(stale, 1.0), asResult(fresh, 0.95)],
    );

    expect(out[0].entry.id).toBe(fresh.id);
  });

  it('preserves input ordering when no signal differentiates', async () => {
    const a = createMemory('alpha bravo charlie');
    const b = createMemory('delta echo foxtrot');

    const out = await featuresReranker('alpha', [asResult(a, 1.0), asResult(b, 0.5)]);

    expect(out[0].entry.id).toBe(a.id);
    expect(out[1].entry.id).toBe(b.id);
  });

  it('respects topK option (does not rerank beyond cap)', async () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      asResult(createMemory(`memory ${i}`), 100 - i),
    );

    const out = await featuresReranker('memory', entries, { topK: 10 });

    expect(out.length).toBe(10);
    expect(out.every((r) => r.rerankScore !== undefined)).toBe(true);
  });

  it('is deterministic across runs', async () => {
    const entries = [
      asResult(createMemory('alpha'), 1.0),
      asResult(createMemory('beta'), 0.9),
      asResult(createMemory('gamma'), 0.8),
    ];
    const a = await featuresReranker('alpha', entries);
    const b = await featuresReranker('alpha', entries);
    expect(a.map((r) => r.entry.id)).toEqual(b.map((r) => r.entry.id));
  });
});
