import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { consolidate } from '../src/consolidate.js';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-batch-extract-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Batch extraction during consolidation', () => {
  it('reports extractionCandidates for episodic memories without facts', async () => {
    initStore(tmpDir);

    const ep1 = createMemory('the deploy pipeline uses blue-green strategy on kubernetes', {
      layer: Layer.Episodic,
    });
    const ep2 = createMemory('redis cache eviction policy is set to allkeys-lru in production', {
      layer: Layer.Episodic,
    });
    writeEntry(tmpDir, ep1);
    writeEntry(tmpDir, ep2);

    const result = await consolidate(tmpDir, { dryRun: false, now: new Date() });

    expect(result.extractionCandidates).toBe(2);
    expect(result.extracted).toBe(0);
  });

  it('skips episodic memories that already have extracted facts', async () => {
    initStore(tmpDir);

    const ep = createMemory('nginx reverse proxy listens on port 443 with TLS termination', {
      layer: Layer.Episodic,
    });
    writeEntry(tmpDir, ep);

    const fact = createMemory('nginx listens on port 443', {
      layer: Layer.Semantic,
      tags: ['extracted'],
      extracted_from: ep.id,
    });
    writeEntry(tmpDir, fact);

    const result = await consolidate(tmpDir, { dryRun: false, now: new Date() });

    expect(result.extractionCandidates).toBe(0);
  });
});
