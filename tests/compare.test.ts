/**
 * Unit tests for the deterministic tie-break comparators in src/compare.ts
 * (docs/plans/2026-07-09-recall-determinism.md T2/T3). Pure functions, no
 * store/DB needed.
 */

import { describe, it, expect } from 'vitest';
import {
  compareEntryIdentity,
  compareScoredResults,
  comparePhysicsResultsBy,
} from '../src/compare.js';

describe('compareEntryIdentity', () => {
  it('orders by content ascending when content differs', () => {
    const a = { content: 'apple', id: 'zzz' };
    const b = { content: 'banana', id: 'aaa' };
    expect(compareEntryIdentity(a, b)).toBeLessThan(0);
    expect(compareEntryIdentity(b, a)).toBeGreaterThan(0);
  });

  it('falls back to id ascending when content is identical', () => {
    const a = { content: 'same text', id: 'b-id' };
    const b = { content: 'same text', id: 'a-id' };
    // content ties -> id decides: 'a-id' < 'b-id'
    expect(compareEntryIdentity(a, b)).toBeGreaterThan(0);
    expect(compareEntryIdentity(b, a)).toBeLessThan(0);
  });

  it('returns 0 for fully identical content and id', () => {
    const a = { content: 'x', id: 'y' };
    const b = { content: 'x', id: 'y' };
    expect(compareEntryIdentity(a, b)).toBe(0);
  });

  it('is a byte compare, not localeCompare — uppercase sorts before lowercase', () => {
    // Byte/ASCII order: 'B' (0x42) < 'a' (0x61), so content "Bravo" < "alpha".
    // localeCompare('Bravo', 'alpha') would place "alpha" first (case-insensitive
    // locale collation) — the opposite order. This pins the byte-compare choice.
    const a = { content: 'Bravo', id: '1' };
    const b = { content: 'alpha', id: '2' };
    expect('Bravo' < 'alpha').toBe(true); // sanity: JS default string compare is byte order
    expect(compareEntryIdentity(a, b)).toBeLessThan(0); // a (Bravo) sorts first
    expect('Bravo'.localeCompare('alpha')).toBeGreaterThan(0); // localeCompare disagrees
  });

  it('ranks layer semantic -> episodic -> trace -> buffer on a content tie, unknown layers last', () => {
    const mk = (layer: string | undefined, id: string) => ({ content: 'same', id, layer });
    const shuffled = [mk('buffer', '1'), mk('weird', '2'), mk('episodic', '3'), mk(undefined, '4'), mk('semantic', '5'), mk('trace', '6')];
    const sorted = [...shuffled].sort(compareEntryIdentity);
    expect(sorted.map((e) => e.layer)).toEqual(['semantic', 'episodic', 'trace', 'buffer', undefined, 'weird']);
  });

  it('prefers more distinct tags, then the sorted tag list, before falling to id', () => {
    const richer = { content: 'same', id: 'z', tags: ['x', 'y'] };
    const poorer = { content: 'same', id: 'a', tags: ['x'] };
    expect(compareEntryIdentity(richer, poorer)).toBeLessThan(0);

    // duplicate tags do not count twice: ['a', 'a'] ties ['b'] on count, then 'a' < 'b'
    const dupA = { content: 'same', id: 'z', tags: ['a', 'a'] };
    const oneB = { content: 'same', id: 'a', tags: ['b'] };
    expect(compareEntryIdentity(dupA, oneB)).toBeLessThan(0);

    // tag order inside the array is irrelevant: equal sets fall through to id
    const ab = { content: 'same', id: 'b', tags: ['a', 'b'] };
    const ba = { content: 'same', id: 'a', tags: ['b', 'a'] };
    expect(compareEntryIdentity(ab, ba)).toBeGreaterThan(0);
  });

  it('orders by source ascending after layer and tags tie', () => {
    const a = { content: 'same', id: 'z', layer: 'episodic', tags: ['t'], source: 'src-a' };
    const b = { content: 'same', id: 'a', layer: 'episodic', tags: ['t'], source: 'src-b' };
    expect(compareEntryIdentity(a, b)).toBeLessThan(0);
    expect(compareEntryIdentity(b, a)).toBeGreaterThan(0);
  });

  it('is a total order: three different starting orders sort to one sequence', () => {
    const entries = [
      { content: 'same', id: 'i1', layer: 'episodic', tags: ['a'], source: 's' },
      { content: 'same', id: 'i2', layer: 'semantic', tags: [], source: 's' },
      { content: 'same', id: 'i3', layer: 'episodic', tags: ['a', 'b'], source: 's' },
      { content: 'same', id: 'i4', layer: 'episodic', tags: ['a'], source: 'r' },
      { content: 'other', id: 'i5' },
      { content: 'same', id: 'i0', layer: 'episodic', tags: ['a'], source: 's' },
    ];
    const orders = [entries, [...entries].reverse(), [entries[3], entries[0], entries[5], entries[1], entries[4], entries[2]]];
    const results = orders.map((o) => [...o].sort(compareEntryIdentity).map((e) => e.id));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual(['i5', 'i2', 'i3', 'i4', 'i0', 'i1']);
  });
});

describe('compareScoredResults', () => {
  it('orders by score descending when scores differ', () => {
    const a = { score: 1, entry: { content: 'z', id: 'z' } };
    const b = { score: 2, entry: { content: 'a', id: 'a' } };
    expect(compareScoredResults(a, b)).toBeGreaterThan(0); // b (higher score) first
  });

  it('falls back to compareEntryIdentity on an exact score tie', () => {
    const a = { score: 5, entry: { content: 'zebra', id: 'x' } };
    const b = { score: 5, entry: { content: 'apple', id: 'y' } };
    // scores tie -> content decides: 'apple' < 'zebra'
    expect(compareScoredResults(a, b)).toBeGreaterThan(0); // b (apple) sorts first
    expect(compareScoredResults(b, a)).toBeLessThan(0);
  });

  it('produces a stable full sort across repeated ties (order-independent of input array order)', () => {
    const items = [
      { score: 5, entry: { content: 'zebra', id: 'x' } },
      { score: 5, entry: { content: 'apple', id: 'y' } },
      { score: 5, entry: { content: 'mango', id: 'z' } },
      { score: 9, entry: { content: 'kiwi', id: 'w' } },
    ];
    const shuffled = [items[2], items[0], items[3], items[1]];
    const sorted = [...shuffled].sort(compareScoredResults);
    expect(sorted.map((r) => r.entry.content)).toEqual(['kiwi', 'apple', 'mango', 'zebra']);
  });
});

describe('comparePhysicsResultsBy', () => {
  it('orders by the supplied score field descending', () => {
    const cmp = comparePhysicsResultsBy<{ memoryId: string; s: number }>((r) => r.s);
    const a = { memoryId: 'm1', s: 1 };
    const b = { memoryId: 'm2', s: 2 };
    expect(cmp(a, b)).toBeGreaterThan(0); // b (higher score) first
  });

  it('falls back to memoryId ascending on an exact score tie (no content available)', () => {
    const cmp = comparePhysicsResultsBy<{ memoryId: string; s: number }>((r) => r.s);
    const a = { memoryId: 'mem-z', s: 5 };
    const b = { memoryId: 'mem-a', s: 5 };
    expect(cmp(a, b)).toBeGreaterThan(0); // b (mem-a) sorts first
    expect(cmp(b, a)).toBeLessThan(0);
  });

  it('supports two independent passes over the same array with different score fields', () => {
    type R = { memoryId: string; baseScore: number; finalScore: number };
    const results: R[] = [
      { memoryId: 'a', baseScore: 1, finalScore: 9 },
      { memoryId: 'b', baseScore: 2, finalScore: 1 },
    ];
    const byBase = [...results].sort(comparePhysicsResultsBy<R>((r) => r.baseScore));
    expect(byBase.map((r) => r.memoryId)).toEqual(['b', 'a']);

    const byFinal = [...results].sort(comparePhysicsResultsBy<R>((r) => r.finalScore));
    expect(byFinal.map((r) => r.memoryId)).toEqual(['a', 'b']);
  });
});

describe('comparePhysicsResultsBy tieKeyOf (content-stable cluster selection)', () => {
  it('breaks score ties by the supplied tie key, not memoryId', () => {
    const a = { memoryId: 'id-zzz', baseScore: 1 };
    const b = { memoryId: 'id-aaa', baseScore: 1 };
    const cmp = comparePhysicsResultsBy<typeof a>((r) => r.baseScore, (r) => (r.memoryId === 'id-zzz' ? 'alpha content' : 'beta content'));
    // tie key 'alpha content' < 'beta content' -> a first despite larger memoryId
    expect([b, a].sort(cmp).map((r) => r.memoryId)).toEqual(['id-zzz', 'id-aaa']);
  });

  it('falls through tie-key collisions to memoryId for a total order', () => {
    const a = { memoryId: 'id-bbb', baseScore: 1 };
    const b = { memoryId: 'id-aaa', baseScore: 1 };
    const cmp = comparePhysicsResultsBy<typeof a>((r) => r.baseScore, () => 'same content');
    expect([a, b].sort(cmp).map((r) => r.memoryId)).toEqual(['id-aaa', 'id-bbb']);
  });
});
