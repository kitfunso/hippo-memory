import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { search } from '../src/search.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-extract-pref-'));
  hippoDir = path.join(tmpDir, '.hippo');
  initStore(hippoDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extraction-aware search preference', () => {
  it('extracted fact scores higher than raw source', () => {
    const raw = createMemory('LeBron James scored 40 points in the basketball game last night', {
      layer: Layer.Episodic,
      tags: ['basketball', 'sports'],
      source: 'cli',
    });
    writeEntry(hippoDir, raw);

    const fact = createMemory('LeBron James scored 40 points in basketball', {
      layer: Layer.Semantic,
      tags: ['basketball', 'sports', 'extracted'],
      source: 'extraction',
      extracted_from: raw.id,
    });
    writeEntry(hippoDir, fact);

    const entries = loadAllEntries(hippoDir);
    const results = search('LeBron basketball points', entries, { budget: 10000 });

    expect(results.length).toBeGreaterThanOrEqual(1);

    const factInResults = results.find((r) => r.entry.id === fact.id);
    const rawInResults = results.find((r) => r.entry.id === raw.id);

    if (factInResults && rawInResults) {
      expect(factInResults.score).toBeGreaterThan(rawInResults.score);
    } else {
      expect(factInResults).toBeDefined();
    }
  });

  it('does not deduplicate unrelated memories', () => {
    const mem1 = createMemory('Python dict ordering is guaranteed in version 3.7 and above', {
      layer: Layer.Semantic,
      tags: ['python'],
      source: 'cli',
    });
    const mem2 = createMemory('TypeScript supports strict null checks for type safety', {
      layer: Layer.Semantic,
      tags: ['typescript'],
      source: 'cli',
    });
    writeEntry(hippoDir, mem1);
    writeEntry(hippoDir, mem2);

    const entries = loadAllEntries(hippoDir);
    const results = search('Python TypeScript programming', entries, { budget: 10000 });

    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain(mem1.id);
    expect(ids).toContain(mem2.id);
  });

  it('extraction boost increases score for tagged memories', () => {
    const tagged = createMemory('Gold futures tend to rise during inflation uncertainty', {
      layer: Layer.Semantic,
      tags: ['gold', 'extracted'],
      source: 'extraction',
    });
    const untagged = createMemory('Gold futures tend to rise during inflation uncertainty', {
      layer: Layer.Semantic,
      tags: ['gold'],
      source: 'cli',
    });
    writeEntry(hippoDir, tagged);
    writeEntry(hippoDir, untagged);

    const entries = loadAllEntries(hippoDir);
    const results = search('gold inflation futures', entries, { budget: 10000 });

    expect(results.length).toBe(2);
    const taggedResult = results.find((r) => r.entry.id === tagged.id)!;
    const untaggedResult = results.find((r) => r.entry.id === untagged.id)!;
    expect(taggedResult.score).toBeGreaterThan(untaggedResult.score);
    expect(taggedResult.score / untaggedResult.score).toBeGreaterThanOrEqual(1.2);
    expect(taggedResult.score / untaggedResult.score).toBeLessThanOrEqual(1.4);
  });

  it('deduplicates source when extracted fact is present', () => {
    const raw = createMemory('The FRED API returned stale CPI data during the March refresh cycle', {
      layer: Layer.Episodic,
      tags: ['error', 'data-pipeline'],
      source: 'cli',
    });
    writeEntry(hippoDir, raw);

    const fact = createMemory('FRED API can return stale CPI data during refresh', {
      layer: Layer.Semantic,
      tags: ['error', 'data-pipeline', 'extracted'],
      source: 'extraction',
      extracted_from: raw.id,
    });
    writeEntry(hippoDir, fact);

    const entries = loadAllEntries(hippoDir);
    const results = search('FRED CPI data stale refresh', entries, { budget: 10000 });

    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain(fact.id);
    expect(ids).not.toContain(raw.id);
  });
});
