// A write that fires its embedding and moves on must log a rejection from the embed path, never leave it unhandled.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailureNotices } from '../../src/base/util/failure-notices.js';
import { loadConfig } from '../../src/host/config-file.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { sharedLocalEmbedder } from '../../src/infra/local-embedder.js';
import { embedMemoryDetached, type EmbedTarget } from '../../src/domain/search/embed-memories.js';
import type { StoreGroups } from '../../src/base/ports/store.js';
import { log } from '../../src/base/util/log.js';
import { makeRoot } from '../_helpers/make-root.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { DetachedSet } from '../../src/base/util/detached-set.js';

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
    // `groups` is read after the provider answers, so a target whose store cannot be reached rejects embedMemory itself.
    const target: EmbedTarget = {
      embeddings: loadConfig(root).embeddings,
      embedderFor: resolveEmbeddingProvider,
      failureNotices: new FailureNotices(),
      strength: PRODUCTION_STRENGTH,
      clock: evalNow,
      get groups(): StoreGroups {
        throw new Error('store is unreachable');
      },
    };
    const entry = createMemory('a memory whose embed path rejects', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    try {
      const detached = new DetachedSet();
      embedMemoryDetached(target, entry, detached);
      await detached.settle();
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
