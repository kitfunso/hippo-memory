// A write that fires its embedding and moves on must log a rejection from the embed path, never leave it unhandled.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { sharedLocalEmbedder } from '../../src/embeddings/local.js';
import { embedMemoryDetached, type EmbedTarget } from '../../src/search/embed-memories.js';
import type { HippoStore } from '../../src/store/port.js';
import { log } from '../../src/util/log.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('embedMemoryDetached', () => {
  it('logs a rejection from the embed path with the error fields instead of leaving it unhandled', async () => {
    const root = makeRoot('embed-detached');
    vi.spyOn(sharedLocalEmbedder, 'isAvailable').mockReturnValue(true);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = <R>(reason: R): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    // `store` is read after the provider answers, so a target whose store cannot be reached rejects embedMemory itself.
    const target: EmbedTarget = {
      hippoRoot: root,
      embeddings: loadConfig(root).embeddings,
      strength: {},
      get store(): HippoStore {
        throw new Error('store is unreachable');
      },
    };
    const entry = createMemory('a memory whose embed path rejects', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    try {
      embedMemoryDetached(target, entry);
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      await new Promise((resolve) => setImmediate(resolve));
      expect(warn).toHaveBeenCalledWith(
        `embedding ${entry.id} failed unexpectedly`,
        expect.objectContaining({ errorClass: 'Error', stack: expect.stringContaining('store is unreachable') }),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
