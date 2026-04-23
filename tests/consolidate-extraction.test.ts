import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { consolidate } from '../src/consolidate.js';
import { initStore, writeEntry, loadAllEntries, listMemoryConflicts } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-consolidate-extract-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Extracted fact protection', () => {
  it('does not merge extracted facts into new semantic entries', async () => {
    initStore(tmpDir);

    const fact1 = createMemory('the deployment uses kubernetes pods on port 8080', {
      layer: Layer.Semantic,
      tags: ['extracted'],
      extracted_from: 'source-memory-1',
    });
    const fact2 = createMemory('the deployment uses kubernetes pods on port 8080 with nginx', {
      layer: Layer.Semantic,
      tags: ['extracted'],
      extracted_from: 'source-memory-2',
    });

    writeEntry(tmpDir, fact1);
    writeEntry(tmpDir, fact2);

    const result = await consolidate(tmpDir, { dryRun: false, now: new Date() });

    expect(result.merged).toBe(0);

    const remaining = loadAllEntries(tmpDir);
    const f1 = remaining.find((e) => e.id === fact1.id);
    const f2 = remaining.find((e) => e.id === fact2.id);
    expect(f1).toBeDefined();
    expect(f2).toBeDefined();
    expect(f1!.content).toBe(fact1.content);
    expect(f2!.content).toBe(fact2.content);
  });

  it('still merges non-extracted episodic memories', async () => {
    initStore(tmpDir);

    const base = 'the server crashed due to memory overflow in the worker process';
    const ep1 = createMemory(base, { layer: Layer.Episodic });
    const ep2 = createMemory(base + ' again today', { layer: Layer.Episodic });
    const ep3 = createMemory(base + ' once more', { layer: Layer.Episodic });

    writeEntry(tmpDir, ep1);
    writeEntry(tmpDir, ep2);
    writeEntry(tmpDir, ep3);

    const result = await consolidate(tmpDir, { dryRun: false, now: new Date() });

    expect(result.merged).toBeGreaterThan(0);
  });

  it('does not detect conflicts between extracted facts', async () => {
    initStore(tmpDir);

    const fact1 = createMemory('always use port 3000 for the dev server', {
      layer: Layer.Episodic,
      tags: ['extracted'],
      extracted_from: 'source-memory-1',
    });
    const fact2 = createMemory('never use port 3000 for the dev server', {
      layer: Layer.Episodic,
      tags: ['extracted'],
      extracted_from: 'source-memory-2',
    });

    writeEntry(tmpDir, fact1);
    writeEntry(tmpDir, fact2);

    await consolidate(tmpDir, { dryRun: false, now: new Date() });

    const conflicts = listMemoryConflicts(tmpDir);
    expect(conflicts.length).toBe(0);
  });
});
