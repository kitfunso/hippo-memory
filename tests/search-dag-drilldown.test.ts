import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { search } from '../src/search.js';

describe('DAG drill-down search', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-search-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('includes child facts when a DAG summary matches', () => {
    const summary = createMemory(
      'John is a basketball player who trains daily and wants to improve his shooting percentage',
      { layer: Layer.Semantic, tags: ['dag-summary', 'speaker:John'], dag_level: 2 },
    );
    writeEntry(hippoRoot, summary);

    const f1 = createMemory('John wants to improve his shooting percentage to lead the league', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John'],
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    const f2 = createMemory('John dreams of winning a national championship', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John'],
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    writeEntry(hippoRoot, f1);
    writeEntry(hippoRoot, f2);

    const entries = loadAllEntries(hippoRoot);
    const results = search('John basketball career goals', entries, { budget: 4000 });

    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain(f1.id);
    expect(ids).toContain(f2.id);
  });

  it('does not inject children when no summary matches', () => {
    const fact = createMemory('Tim reads sci-fi novels', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:Tim'],
      dag_level: 1,
    });
    writeEntry(hippoRoot, fact);

    const entries = loadAllEntries(hippoRoot);
    const results = search('Tim reading', entries, { budget: 4000 });

    expect(results.some((r) => r.entry.id === fact.id)).toBe(true);
  });
});
