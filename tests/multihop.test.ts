import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { multihopSearch } from '../src/multihop.js';

describe('multihopSearch', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-multihop-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('chains retrieval to answer multi-hop questions', () => {
    writeEntry(hippoRoot, createMemory('John scored 30 points in the January 2024 game', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
    }));
    writeEntry(hippoRoot, createMemory('John achieved a career-high score in the January 2024 game', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
    }));
    writeEntry(hippoRoot, createMemory('Nike offered John an endorsement deal in February 2024', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:endorsement'],
    }));
    writeEntry(hippoRoot, createMemory('Tim likes reading sci-fi novels', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:Tim'],
    }));

    const entries = loadAllEntries(hippoRoot);
    const results = multihopSearch(
      'In which month did John achieve career-high and then get an endorsement?',
      entries,
      { budget: 4000 },
    );

    const contents = results.map((r) => r.entry.content);
    expect(contents.some((c) => c.includes('career-high'))).toBe(true);
    expect(contents.some((c) => c.includes('endorsement'))).toBe(true);
  });

  it('returns pass1 results when no new entities discovered', () => {
    writeEntry(hippoRoot, createMemory('Alice enjoys hiking in mountains', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:Alice'],
    }));

    const entries = loadAllEntries(hippoRoot);
    const results = multihopSearch('Alice hiking', entries, { budget: 4000 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain('Alice');
  });
});
