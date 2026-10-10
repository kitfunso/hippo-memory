import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/store/embeddings/index.js';
import { cosineOf } from '../src/core/cosine.js';
import { queryGravityMagnitude, type PhysicsParticle } from '../src/core/physics.js';

function particleAt(position: number[]): PhysicsParticle {
  return { memoryId: 'm', position, velocity: [], mass: 1, charge: 0, temperature: 1, lastSimulation: '2026-01-01T00:00:00.000Z' };
}

describe('one cosine for embeddings and physics', () => {
  const cases: Array<[string, number[], number[]]> = [
    ['empty', [], []],
    ['length mismatch', [1, 0], [1, 0, 0]],
    ['zero vector', [0, 0, 0], [1, 2, 3]],
    ['identical', [1, 2, 3], [1, 2, 3]],
    ['unnormalized parallel', [2, 0, 0], [5, 0, 0]],
    ['orthogonal', [1, 0], [0, 1]],
  ];

  it.each(cases)('%s: embeddings, shared helper and physics gravity agree', (_name, a, b) => {
    const cos = cosineOf(a, b);
    expect(cosineSimilarity(a, b)).toBe(cos);
    expect(queryGravityMagnitude(particleAt(a), b, 1)).toBeCloseTo(Math.max(0, cos) ** 2, 12);
  });

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
