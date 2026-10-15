import { describe, it, expect } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { search } from '../src/search/bm25-search.js';

const mk = (text: string) => createMemory(text, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });

describe('bm25 search corpus reuse', () => {
  it('repeats the same results on one array and never reuses a corpus for a different pool', () => {
    const entries = [mk('cache refresh pipeline error'), mk('jwt authentication tokens'), mk('deploy rollback plan')];
    const first = search('cache pipeline', entries);
    expect(search('cache pipeline', entries).map((r) => r.entry.id)).toEqual(first.map((r) => r.entry.id));

    entries.push(mk('cache pipeline cache pipeline stall'));
    const grown = search('cache pipeline', entries);
    expect(grown.some((r) => r.entry.id === entries[3].id)).toBe(true);

    const fresh = search('cache pipeline', [...entries]);
    expect(grown.map((r) => [r.entry.id, r.bm25])).toEqual(fresh.map((r) => [r.entry.id, r.bm25]));
  });
});
