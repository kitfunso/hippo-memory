import { describe, it, expect } from 'vitest';
import { rrfFuse, RRF_K } from '../src/rrf.js';

describe('rrf', () => {
  describe('RRF_K constant (invariant — must match the canonical Cormack et al. 2009 value)', () => {
    it('exports RRF_K === 60', () => {
      expect(RRF_K).toBe(60);
    });
  });

  describe('rrfFuse — happy path', () => {
    it('two lists with perfect agreement: fused order matches input order, scores are summed', () => {
      const a = ['x', 'y', 'z'] as const;
      const b = ['x', 'y', 'z'] as const;
      const out = rrfFuse([a, b], [0.5, 0.5]);
      // Equal weights, identical lists. x gets 0.5/(60+1) + 0.5/(60+1) = 1/(61).
      // y gets 1/(62). z gets 1/(63). Ordering preserved.
      const sorted = [...out.entries()].sort((p, q) => q[1] - p[1]).map(([id]) => id);
      expect(sorted).toEqual(['x', 'y', 'z']);
      expect(out.get('x')).toBeCloseTo(1 / 61, 10);
      expect(out.get('y')).toBeCloseTo(1 / 62, 10);
      expect(out.get('z')).toBeCloseTo(1 / 63, 10);
    });

    it('two lists in reverse order with equal weights: fused score is uniform', () => {
      const a = ['x', 'y', 'z'] as const;
      const b = ['z', 'y', 'x'] as const;
      const out = rrfFuse([a, b], [0.5, 0.5]);
      // Each candidate appears at rank 1 in one list and rank 3 in the other,
      // EXCEPT y which is rank 2 in both. Equal weights → x and z get the
      // same total; y is slightly different. The rank-symmetric property
      // (Cormack 2009) is what we're asserting.
      const x = out.get('x')!;
      const z = out.get('z')!;
      expect(x).toBeCloseTo(z, 10);
    });

    it('weight = 0 on one list reduces to single-list ordering', () => {
      const a = ['x', 'y', 'z'] as const;
      const b = ['z', 'y', 'x'] as const;
      const out = rrfFuse([a, b], [1.0, 0.0]);
      const sorted = [...out.entries()].sort((p, q) => q[1] - p[1]).map(([id]) => id);
      // Only list `a` contributes; ordering follows `a`.
      expect(sorted).toEqual(['x', 'y', 'z']);
    });
  });

  describe('rrfFuse — partial candidate overlap', () => {
    it('candidate present in only one list uses default absentRank = maxListLen + 1', () => {
      const a = ['x', 'y'];           // length 2
      const b = ['z'];                 // length 1
      // maxListLen = 2; absentRank defaults to 3.
      const out = rrfFuse([a, b], [0.5, 0.5]);
      // x: in a@1, absent from b (rank 3) → 0.5/61 + 0.5/63
      // y: in a@2, absent from b (rank 3) → 0.5/62 + 0.5/63
      // z: absent from a (rank 3), in b@1 → 0.5/63 + 0.5/61
      // x and z should have identical scores by symmetry.
      const xScore = out.get('x')!;
      const zScore = out.get('z')!;
      expect(xScore).toBeCloseTo(zScore, 10);
      // y < x (y has worse rank in `a` and same fallback in `b`)
      expect(out.get('y')!).toBeLessThan(xScore);
    });

    it('explicit absentRank override is honoured', () => {
      const a = ['x'];
      const b = ['y'];
      const out = rrfFuse([a, b], [1, 1], { absentRank: 100 });
      // x: in a@1, absent in b → 1/61 + 1/160
      // y: absent in a → 1/160 + in b@1 → 1/61
      expect(out.get('x')!).toBeCloseTo(out.get('y')!, 10);
      expect(out.get('x')!).toBeCloseTo(1 / 61 + 1 / 160, 10);
    });
  });

  describe('rrfFuse — custom k', () => {
    it('k=1 weights top ranks much more strongly than k=60', () => {
      const a = ['x', 'y'];
      const b = ['y', 'x'];
      const k1 = rrfFuse([a, b], [0.5, 0.5], { k: 1 });
      const k60 = rrfFuse([a, b], [0.5, 0.5], { k: 60 });
      // With k=1, ranks 1 and 2 produce 1/2 and 1/3 — large ratio.
      // With k=60, ranks 1 and 2 produce 1/61 and 1/62 — near-equal.
      // x and y get the same fused score in both (rank-symmetric pair),
      // but the absolute magnitudes differ.
      const xK1 = k1.get('x')!;
      const xK60 = k60.get('x')!;
      expect(xK1).toBeGreaterThan(xK60); // smaller k → larger 1/(k+rank)
    });
  });

  describe('rrfFuse — input validation', () => {
    it('throws if weights.length does not match rankedLists.length', () => {
      expect(() => rrfFuse([['x']], [0.5, 0.5])).toThrow(/length/);
    });

    it('empty input returns empty map', () => {
      const out = rrfFuse([], []);
      expect(out.size).toBe(0);
    });

    it('all-empty ranked lists return empty map', () => {
      const out = rrfFuse([[], []], [0.5, 0.5]);
      expect(out.size).toBe(0);
    });
  });

  describe('rrfFuse — generic over candidate type', () => {
    it('works with numeric ids', () => {
      const out = rrfFuse<number>([[1, 2, 3], [3, 2, 1]], [0.5, 0.5]);
      expect(out.size).toBe(3);
      expect(out.get(1)).toBeCloseTo(out.get(3)!, 10);
    });

    it('works with object ids (reference equality via Map)', () => {
      const a = { id: 'a' };
      const b = { id: 'b' };
      const out = rrfFuse<typeof a>([[a, b]], [1.0]);
      expect(out.get(a)).toBeCloseTo(1 / 61, 10);
      expect(out.get(b)).toBeCloseTo(1 / 62, 10);
    });
  });
});
