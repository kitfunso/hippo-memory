import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer } from '../../src/base/memory/memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

describe('decision memory', () => {
  let hippoRoot: string;

  beforeEach(() => {
    ({ root: hippoRoot } = makeStore('decision'));
  });

  it('creates a decision memory on the default half-life', () => {
    const mem = createMemory('Use PostgreSQL over MySQL for JSONB support', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['decision', 'database'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'decision',
    });
    writeEntry(hippoRoot, mem);

    const entry = readEntry(hippoRoot, mem.id);
    expect(entry).not.toBeNull();
    expect(entry!.tags).toContain('decision');
    expect(entry!.layer).toBe('semantic');
    expect(entry!.confidence).toBe('verified');
    expect(entry!.halfLifeDays).toBe(DEFAULT_HALF_LIFE_DAYS);
    expect(entry!.source).toBe('decision');
  });

  it('decision can be superseded by halving half-life', () => {
    const mem = createMemory('Use REST for all public APIs', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['decision', 'api'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'decision',
    });
    writeEntry(hippoRoot, mem);

    // Supersede
    const old = readEntry(hippoRoot, mem.id)!;
    old.halfLifeDays = Math.max(1, Math.floor(old.halfLifeDays / 2));
    old.confidence = 'stale';
    if (!old.tags.includes('superseded')) old.tags.push('superseded');
    writeEntry(hippoRoot, old);

    const updated = readEntry(hippoRoot, mem.id)!;
    expect(updated.halfLifeDays).toBe(Math.floor(DEFAULT_HALF_LIFE_DAYS / 2));
    expect(updated.tags).toContain('superseded');
    expect(updated.confidence).toBe('stale');
  });
});
