import { describe, it, expect } from 'vitest';
import { cosineOf } from '../../src/base/rank/cosine.js';

describe('the cosine every ranking site shares', () => {
  it('guards return 0 and identical vectors return 1', () => {
    expect(cosineOf([], [])).toBe(0);
    expect(cosineOf([1], [1, 1])).toBe(0);
    expect(cosineOf([0, 0], [1, 1])).toBe(0);
    expect(cosineOf([1, 2], [1, 2])).toBeCloseTo(1, 12);
  });

  it('reads a Float32 view the same as its number[] copy', () => {
    expect(cosineOf(new Float32Array([1, 2, 3]), new Float32Array([3, 2, 1]))).toBe(cosineOf([1, 2, 3], [3, 2, 1]));
  });
});
