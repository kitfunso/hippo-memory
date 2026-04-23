import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { consolidate } from '../src/consolidate.js';

describe('DAG construction during consolidation', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-build-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('reports dagCandidateClusters in consolidation result', async () => {
    for (let i = 0; i < 4; i++) {
      const fact = createMemory(`John basketball fact ${i}`, {
        layer: Layer.Semantic,
        tags: ['extracted', 'speaker:John', 'topic:basketball'],
        extracted_from: `source-${i}`,
        dag_level: 1,
      });
      writeEntry(hippoRoot, fact);
    }

    const result = await consolidate(hippoRoot, { dryRun: false });
    expect(result).toHaveProperty('dagCandidateClusters');
  });

  it('dagCandidateClusters is 0 when no extracted facts exist', async () => {
    const entry = createMemory('plain memory with no extraction', {
      layer: Layer.Episodic,
    });
    writeEntry(hippoRoot, entry);

    const result = await consolidate(hippoRoot, { dryRun: false });
    expect(result.dagCandidateClusters).toBe(0);
  });
});
