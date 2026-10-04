import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer } from '../src/memory.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('decision memory', () => {
  let tmpDir: string;
  let hippoRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-decision-'));
    hippoRoot = path.join(tmpDir, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    expect(entry!.half_life_days).toBe(DEFAULT_HALF_LIFE_DAYS);
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
    old.half_life_days = Math.max(1, Math.floor(old.half_life_days / 2));
    old.confidence = 'stale';
    if (!old.tags.includes('superseded')) old.tags.push('superseded');
    writeEntry(hippoRoot, old);

    const updated = readEntry(hippoRoot, mem.id)!;
    expect(updated.half_life_days).toBe(Math.floor(DEFAULT_HALF_LIFE_DAYS / 2));
    expect(updated.tags).toContain('superseded');
    expect(updated.confidence).toBe('stale');
  });
});
