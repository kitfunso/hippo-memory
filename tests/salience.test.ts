import { describe, it, expect } from 'vitest';
import { createMemory, type MemoryEntry } from '../src/memory.js';
import { computeSalience } from '../src/salience.js';

function mem(content: string, opts: { tags?: string[]; emotional_valence?: string } = {}): MemoryEntry {
  const entry = createMemory(content, { tags: opts.tags ?? [] });
  if (opts.emotional_valence) (entry as any).emotional_valence = opts.emotional_valence;
  return entry;
}

describe('computeSalience', () => {
  it('skips content shorter than minContentLength', () => {
    const result = computeSalience('hi', [], []);
    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('content_too_short');
  });

  it('stores pinned content regardless', () => {
    const result = computeSalience('hi', ['pinned'], []);
    expect(result.decision).toBe('store');
    expect(result.score).toBe(1.0);
  });

  it('stores novel content', () => {
    const result = computeSalience('This is a completely novel piece of information about database migrations', [], []);
    expect(result.decision).toBe('store');
    expect(result.reason).toBe('novel');
  });

  it('skips duplicate content', () => {
    const existing = [mem('Database migration failed with timeout error on production')];
    const result = computeSalience(
      'Database migration failed with timeout error on production',
      [],
      existing,
    );
    expect(result.decision).toBe('skip');
    expect(result.reason).toContain('duplicate');
  });

  it('stores error content despite overlap', () => {
    const existing = [mem('Database migration failed with timeout error')];
    const result = computeSalience(
      'Database migration failed with timeout error',
      ['error'],
      existing,
    );
    expect(result.decision).toBe('store');
    expect(result.reason).toBe('error_despite_overlap');
  });

  it('weakens repeat errors when too many recent', () => {
    const recent = Array.from({ length: 5 }, (_, i) =>
      mem(`Error ${i}: connection timeout on database`, {
        tags: ['error'],
        emotional_valence: 'negative',
      })
    );
    const result = computeSalience(
      'Error 5: connection timeout on database',
      ['error'],
      recent,
    );
    expect(result.decision).toBe('start_weak');
    expect(result.score).toBeLessThan(0.5);
  });

  it('stores novel errors at high score', () => {
    const result = computeSalience(
      'Never seen before: quantum decoherence in memory subsystem',
      ['error'],
      [],
    );
    expect(result.decision).toBe('store');
    expect(result.reason).toBe('error_novel');
    expect(result.score).toBe(0.9);
  });

  it('boosts score for structured tags', () => {
    const plain = computeSalience('Some useful information about the project', [], []);
    const structured = computeSalience(
      'Some useful information about the project',
      ['topic:architecture'],
      [],
    );
    expect(structured.score).toBeGreaterThan(plain.score);
  });

  it('boosts score for longer content', () => {
    const short = computeSalience('Short but valid content here', [], []);
    const long = computeSalience(
      'This is a much longer piece of content that contains significantly more information about the topic at hand, including details about implementation, architecture decisions, and tradeoffs that were considered during the design phase of the system under discussion',
      [],
      [],
    );
    expect(long.score).toBeGreaterThan(short.score);
  });

  it('respects custom overlapThreshold', () => {
    const existing = [mem('The quick brown fox jumps over the lazy dog near the river')];
    const strictResult = computeSalience(
      'The quick brown fox jumps over the lazy dog near the river',
      [],
      existing,
      { overlapThreshold: 0.3 },
    );
    expect(strictResult.decision).toBe('skip');
  });
});
