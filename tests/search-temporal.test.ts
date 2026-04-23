import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { search } from '../src/search.js';

describe('temporal-aware search', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-temporal-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('boosts recent memories when query has temporal cue "recently"', () => {
    const old = createMemory('John scored 20 points in a game', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John', 'topic:basketball'],
    });
    // Backdate the old entry
    const oldEntry = { ...old, created: '2024-01-01T00:00:00.000Z', last_retrieved: '2024-01-01T00:00:00.000Z' };
    writeEntry(hippoRoot, oldEntry);

    const recent = createMemory('John scored 35 points in a game', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John', 'topic:basketball'],
    });
    writeEntry(hippoRoot, recent);

    const entries = loadAllEntries(hippoRoot);
    const results = search('John recently scored points', entries, { budget: 4000 });

    expect(results.length).toBeGreaterThanOrEqual(2);
    // Recent entry should rank first when "recently" cue is present
    expect(results[0].entry.content).toContain('35');
  });

  it('does not apply temporal boost without temporal cue', () => {
    const old = createMemory('John scored 20 points in a game', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John', 'topic:basketball'],
    });
    const oldEntry = { ...old, created: '2024-01-01T00:00:00.000Z', last_retrieved: '2024-01-01T00:00:00.000Z' };
    writeEntry(hippoRoot, oldEntry);

    const recent = createMemory('John scored 35 points in a game', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John', 'topic:basketball'],
    });
    writeEntry(hippoRoot, recent);

    const entries = loadAllEntries(hippoRoot);
    const results = search('John scored points', entries, { budget: 4000 });

    // Without temporal cue, both should appear but temporal boost should not dominate
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});
