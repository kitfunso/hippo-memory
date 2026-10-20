import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { embedMemory } from '../../src/domain/search/embed-memories.js';
import { sharedLocalEmbedder } from '../../src/base/embeddings/local.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

let root: string;

beforeEach(() => {
  root = makeRoot('embed-avail');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('embedMemory when the provider availability probe throws', () => {
  it('resolves failed instead of rejecting a fire-and-forget caller', async () => {
    vi.spyOn(sharedLocalEmbedder, 'isAvailable').mockImplementation(() => {
      throw new Error('availability probe blew up');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const entry = createMemory('a memory whose provider probe throws', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);
    await expect(embedMemory(localIndex(root), entry)).resolves.toBe('failed');
  });
});
