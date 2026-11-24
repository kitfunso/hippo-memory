import { describe, it, expect } from 'vitest';
import { tokenize, jaccard, stem } from '../../tools/jaccard-overlap.mjs';

describe('jaccard-overlap', () => {
  it('jaccard of identical sets is 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('jaccard of disjoint sets is 0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });

  it('jaccard handles partial overlap', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
  });

  it('jaccard of two empty sets is 0 (degenerate, not NaN)', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('tokenize drops short tokens', () => {
    const tokens = tokenize('a is on');
    expect(tokens.size).toBe(0);
  });

  it('tokenize drops engineering function-verb stop-words', () => {
    const tokens = tokenize('use makes get sets running found seen given taken');
    expect(tokens.size).toBe(0);
  });

  it('Porter-stem strips common suffixes', () => {
    expect(stem('verifies')).toBe('verify');
    expect(stem('verifying')).toBe('verify');
    expect(stem('verified')).toBe('verifi');
    expect(stem('verification')).toBe('verifica');
    expect(stem('retries')).toBe('retry');
    expect(stem('recalls')).toBe('recall');
  });

  it('Porter-stem collapses singular/plural and tense pairs', () => {
    expect(stem('verifies')).toBe(stem('verify'));
  });

  it('tokenize end-to-end produces expected stem set', () => {
    const tokens = tokenize('Persisting instants in UTC across daylight-saving boundaries.');
    expect(tokens.has('utc')).toBe(true);
    expect(tokens.has('instant')).toBe(true);
    expect(tokens.has('daylight')).toBe(true);
    expect(tokens.has('saving')).toBe(false);
    expect(tokens.has('in')).toBe(false);
    expect(tokens.has('across')).toBe(false);
  });
});
