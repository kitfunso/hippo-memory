import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

describe('schema v13: DAG fields', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = makeRoot('dag');
  });

  it('stores dag_level and dag_parent_id', () => {
    const summary = createMemory('John is a basketball player who trains daily', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);

    const fact = createMemory('John scored 30 points on Jan 2', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 1,
      dagParentId: summary.id,
    });
    writeEntry(hippoRoot, fact);

    const loadedFact = readEntry(hippoRoot, fact.id);
    expect(loadedFact!.dagLevel).toBe(1);
    expect(loadedFact!.dagParentId).toBe(summary.id);

    const loadedSummary = readEntry(hippoRoot, summary.id);
    expect(loadedSummary!.dagLevel).toBe(2);
    expect(loadedSummary!.dagParentId).toBeNull();
  });

  it('defaults dag_level to 0 and dag_parent_id to null', () => {
    const entry = createMemory('plain memory', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(hippoRoot, entry);

    const loaded = readEntry(hippoRoot, entry.id);
    expect(loaded!.dagLevel).toBe(0);
    expect(loaded!.dagParentId).toBeNull();
  });
});
