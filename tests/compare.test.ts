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
