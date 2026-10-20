import { describe, it, expect, beforeEach } from 'vitest';
import { consolidate } from '../../src/index.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('batch-extract', { init: false });
});

describe('Batch extraction during consolidation', () => {
  it('reports extractionCandidates for episodic memories without facts', async () => {
    initTestStore(tmpDir);

    const ep1 = createMemory('the deploy pipeline uses blue-green strategy on kubernetes', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    const ep2 = createMemory('redis cache eviction policy is set to allkeys-lru in production', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(tmpDir, ep1);
    writeEntry(tmpDir, ep2);

    const result = await consolidate(tmpDir, { dryRun: false, now: new Date() });

    expect(result.extractionCandidates).toBe(2);
    expect(result.extracted).toBe(0);
  });

  it('skips episodic memories that already have extracted facts', async () => {
    initTestStore(tmpDir);

    const ep = createMemory('nginx reverse proxy listens on port 443 with TLS termination', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(tmpDir, ep);

    const fact = createMemory('nginx listens on port 443', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      tags: ['extracted'],
      extractedFrom: ep.id,
    });
    writeEntry(tmpDir, fact);

    const result = await consolidate(tmpDir, { dryRun: false, now: new Date() });

    expect(result.extractionCandidates).toBe(0);
  });
});
