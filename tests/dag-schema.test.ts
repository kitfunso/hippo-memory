import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

describe('schema v13: DAG fields', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('stores dag_level and dag_parent_id', () => {
    const summary = createMemory('John is a basketball player who trains daily', {
      layer: Layer.Semantic,
      dag_level: 2,
    });
    writeEntry(hippoRoot, summary);

    const fact = createMemory('John scored 30 points on Jan 2', {
      layer: Layer.Semantic,
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    writeEntry(hippoRoot, fact);

    const loadedFact = readEntry(hippoRoot, fact.id);
    expect(loadedFact!.dag_level).toBe(1);
    expect(loadedFact!.dag_parent_id).toBe(summary.id);

    const loadedSummary = readEntry(hippoRoot, summary.id);
    expect(loadedSummary!.dag_level).toBe(2);
    expect(loadedSummary!.dag_parent_id).toBeNull();
  });

  it('defaults dag_level to 0 and dag_parent_id to null', () => {
    const entry = createMemory('plain memory', {});
    writeEntry(hippoRoot, entry);

    const loaded = readEntry(hippoRoot, entry.id);
    expect(loaded!.dag_level).toBe(0);
    expect(loaded!.dag_parent_id).toBeNull();
  });
});
