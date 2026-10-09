import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { Layer} from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { multihopSearch } from '../src/search/multihop.js';

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

  // Pass 1 runs at twice the budget, so each return path must fit its list to the caller's budget.
  describe.each([
    { path: 'merged union of both passes', tag: 'speaker:Maya', query: 'deploy failure pipeline' },
    { path: 'early return when pass 1 finds no new entity', tag: 'speaker:Alice', query: 'Alice deploy failure pipeline' },
  ])('budget on the $path', ({ tag, query }) => {
    const flat = (): number => 100;

    beforeEach(() => {
      for (let i = 0; i < 6; i++) {
        writeEntry(hippoRoot, createMemory(`Deploy failure ${i}: the release pipeline timed out on step ${i}`, {
          layer: Layer.Semantic, tags: ['extracted', tag],
        }));
      }
    });

    it('spends no more than the budget under a cost', () => {
      const results = multihopSearch(query, loadAllEntries(hippoRoot), { budget: 250, cost: flat });
      expect(results).toHaveLength(2);
    });

    it('keeps the minResults floor whatever it costs', () => {
      const results = multihopSearch(query, loadAllEntries(hippoRoot), { budget: 50, cost: flat, minResults: 3 });
      expect(results).toHaveLength(3);
    });

    it('returns nothing that misses the budget when minResults is 0', () => {
      const results = multihopSearch(query, loadAllEntries(hippoRoot), { budget: 50, cost: flat, minResults: 0 });
      expect(results).toHaveLength(0);
    });

    it('fits to the memory text when no cost is given', () => {
      const entries = loadAllEntries(hippoRoot);
      const one = entries[0].content.length / 4;
      const results = multihopSearch(query, entries, { budget: Math.ceil(one * 2.5) });
      expect(results.reduce((s, r) => s + r.tokens, 0)).toBeLessThanOrEqual(Math.ceil(one * 2.5));
    });
  });
});
