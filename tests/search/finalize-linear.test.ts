// dedupeExtracted and withDagChildren do one map step per result, so a large result list costs a linear count of reads.
import { describe, expect, it } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { dedupeExtracted, withDagChildren } from '../../src/search/finalize.js';
import type { MemoryEntry } from '../../src/core/memory.js';
import type { SearchResult } from '../../src/core/search-types.js';

const N = 3000;

function result(entry: MemoryEntry, score = 1): SearchResult {
  return { entry, score, bm25: 0, cosine: 0, tokens: 1 };
}

/** An entry whose id reads are counted, so a scan over earlier results shows up as reads. */
function countedEntry(id: string, counter: { reads: number }, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const base = { ...createMemory(`row ${id}`, { baseHalfLifeDays: 30 }), ...extra };
  return Object.defineProperty(base, 'id', {
    get() {
      counter.reads += 1;
      return id;
    },
    enumerable: true,
  });
}

describe('dedupeExtracted', () => {
  it('drops a source when its extracted fact matches, keeps the fact where it arrived, and ignores a fact met first', () => {
    const plain = (id: string, extractedFrom: string | null = null): SearchResult =>
      result({ ...createMemory(`row ${id}`, { baseHalfLifeDays: 30 }), id, extractedFrom });
    const scored = [
      plain('a'),
      plain('src'),
      plain('b'),
      plain('fact', 'src'),
      plain('c'),
      plain('early-fact', 'late'),
    ];
    scored.push(plain('late'));

    expect(dedupeExtracted(scored).map((r) => r.entry.id)).toEqual(['a', 'b', 'fact', 'c', 'early-fact']);
  });

  it('reads each id a bounded number of times however many results come before it', () => {
    const counter = { reads: 0 };
    const scored: SearchResult[] = [];
    for (let i = 0; i < N; i++) scored.push(result(countedEntry(`src${i}`, counter)));
    // Newest source first, so the source each fact drops is the one furthest from the front.
    for (let i = 0; i < N; i++) {
      scored.push(result(countedEntry(`fact${i}`, counter, { extractedFrom: `src${N - 1 - i}` })));
    }

    const out = dedupeExtracted(scored);

    expect(out).toHaveLength(N);
    expect(out.every((r) => r.entry.extractedFrom !== undefined)).toBe(true);
    // The scan this replaced read an id for every earlier result: about N * N / 2 reads here.
    expect(counter.reads).toBeLessThan(10 * N);
  });
});

describe('withDagChildren', () => {
  it('adds a missing child at 0.9x its parent and skips one already in the results', () => {
    const summary = result({ ...createMemory('summary', { baseHalfLifeDays: 30 }), id: 's', tags: ['dag-summary'] }, 2);
    const held = result({ ...createMemory('held child', { baseHalfLifeDays: 30 }), id: 'held', dagParentId: 's' }, 0.1);
    const fresh = { ...createMemory('fresh child', { baseHalfLifeDays: 30 }), id: 'fresh', dagParentId: 's' };

    const out = withDagChildren([summary, held], [held.entry, fresh]);

    expect(out.map((r) => [r.entry.id, r.score])).toEqual([
      ['s', 2],
      ['fresh', 2 * 0.9],
      ['held', 0.1],
    ]);
  });

  it('reads each id a bounded number of times for many children', () => {
    const counter = { reads: 0 };
    const summary = result({ ...createMemory('summary', { baseHalfLifeDays: 30 }), id: 's', tags: ['dag-summary'] });
    const pool: MemoryEntry[] = [];
    for (let i = 0; i < N; i++) pool.push(countedEntry(`child${i}`, counter, { dagParentId: 's' }));

    const out = withDagChildren([summary], pool);

    expect(out).toHaveLength(N + 1);
    expect(counter.reads).toBeLessThan(10 * N);
  });
});
