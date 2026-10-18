import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { consolidate } from '../../src/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

describe('DAG construction during consolidation', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = makeRoot('dag-build');
  });

  it('reports dagCandidateClusters in consolidation result', async () => {
    for (let i = 0; i < 4; i++) {
      const fact = createMemory(`John basketball fact ${i}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Semantic,
        tags: ['extracted', 'speaker:John', 'topic:basketball'],
        extractedFrom: `source-${i}`,
        dagLevel: 1,
      });
      writeEntry(hippoRoot, fact);
    }

    const result = await consolidate(hippoRoot, { dryRun: false });
    expect(result).toHaveProperty('dagCandidateClusters');
  });

  it('dagCandidateClusters is 0 when no extracted facts exist', async () => {
    const entry = createMemory('plain memory with no extraction', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(hippoRoot, entry);

    const result = await consolidate(hippoRoot, { dryRun: false });
    expect(result.dagCandidateClusters).toBe(0);
  });
});
