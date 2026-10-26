import { describe, it, expect } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { rankBm25 } from '../../src/domain/search/bm25-search.js';
import { evalNow } from '../../src/infra/eval-switches.js';

const mk = (text: string) => createMemory(text, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });

describe('bm25 search corpus reuse', () => {
  it('repeats the same results on one array and never reuses a corpus for a different pool', () => {
    const entries = [mk('cache refresh pipeline error'), mk('jwt authentication tokens'), mk('deploy rollback plan')];
    const first = rankBm25('cache pipeline', entries, { now: evalNow() });
    expect(rankBm25('cache pipeline', entries, { now: evalNow() }).map((r) => r.entry.id)).toEqual(
      first.map((r) => r.entry.id),
    );

    entries.push(mk('cache pipeline cache pipeline stall'));
    const grown = rankBm25('cache pipeline', entries, { now: evalNow() });
    expect(grown.some((r) => r.entry.id === entries[3].id)).toBe(true);

    const fresh = rankBm25('cache pipeline', [...entries], { now: evalNow() });
    expect(grown.map((r) => [r.entry.id, r.bm25])).toEqual(fresh.map((r) => [r.entry.id, r.bm25]));
  });
});
