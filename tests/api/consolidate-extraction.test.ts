import { describe, it, expect, beforeEach } from 'vitest';
import { consolidate } from '../../src/index.js';
import { listMemoryConflicts, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';

pinClock();

oneRequestPerTest();

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('consolidate-extract', { init: false });
});

describe('Extracted fact protection', () => {
  it('does not merge extracted facts into new semantic entries', async () => {
    initTestStore(tmpDir);

    const fact1 = createMemory('the deployment uses kubernetes pods on port 8080', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      tags: ['extracted'],
      extractedFrom: 'source-memory-1',
    });
    const fact2 = createMemory('the deployment uses kubernetes pods on port 8080 with nginx', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      tags: ['extracted'],
      extractedFrom: 'source-memory-2',
    });

    writeEntry(tmpDir, fact1);
    writeEntry(tmpDir, fact2);

    const result = await consolidate(tmpDir, { dryRun: false, now: FIXED_NOW });

    expect(result.merged).toBe(0);

    const remaining = loadAllEntries(tmpDir, 'default');
    const f1 = remaining.find((e) => e.id === fact1.id);
    const f2 = remaining.find((e) => e.id === fact2.id);
    expect(f1!.content).toBe(fact1.content);
    expect(f2!.content).toBe(fact2.content);
  });

  it('still merges non-extracted episodic memories', async () => {
    initTestStore(tmpDir);

    const base = 'the server crashed due to memory overflow in the worker process';
    const ep1 = createMemory(base, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
    const ep2 = createMemory(base + ' again today', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    const ep3 = createMemory(base + ' once more', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });

    writeEntry(tmpDir, ep1);
    writeEntry(tmpDir, ep2);
    writeEntry(tmpDir, ep3);

    const result = await consolidate(tmpDir, { dryRun: false, now: FIXED_NOW });

    // Every pair overlaps past the merge threshold, so all three episodes form one cluster.
    expect(result.merged).toBe(3);
  });

  it('does not detect conflicts between extracted facts', async () => {
    initTestStore(tmpDir);

    const fact1 = createMemory('always use port 3000 for the dev server', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      tags: ['extracted'],
      extractedFrom: 'source-memory-1',
    });
    const fact2 = createMemory('never use port 3000 for the dev server', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      tags: ['extracted'],
      extractedFrom: 'source-memory-2',
    });

    writeEntry(tmpDir, fact1);
    writeEntry(tmpDir, fact2);

    await consolidate(tmpDir, { dryRun: false, now: FIXED_NOW });

    const conflicts = listMemoryConflicts(tmpDir);
    expect(conflicts.length).toBe(0);
  });
});
