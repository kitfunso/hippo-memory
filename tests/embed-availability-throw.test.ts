import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { embedMemory } from '../src/search/embed-memories.js';
import { sharedLocalEmbedder } from '../src/embeddings/local.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-avail-'));
  initStore(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('embedMemory when the provider availability probe throws', () => {
  it('resolves failed instead of rejecting a fire-and-forget caller', async () => {
    vi.spyOn(sharedLocalEmbedder, 'isAvailable').mockImplementation(() => {
      throw new Error('availability probe blew up');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const entry = createMemory('a memory whose provider probe throws', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);
    await expect(embedMemory(root, entry)).resolves.toBe('failed');
  });
});
