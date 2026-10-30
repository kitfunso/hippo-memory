// An embed run that finds the index's lock held asks again at a doubling interval, capped at a second, and gives up
// on the 10 s deadline: 15 asks in the budget, not one every 50 ms.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailureNotices } from '../../src/base/util/failure-notices.js';
import { join } from 'node:path';
import { takeFileLock } from '../../src/host/file-lock.js';
import { loadConfig } from '../../src/host/config-file.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import type { EmbeddingIndex } from '../../src/base/ports/store.js';
import { hashedVector } from '../_helpers/hashed-embedding-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { storeAt } from '../_helpers/cli-stores.js';

const ASKED_AT_MS = [0, 50, 150, 350, 750, 1550, 2550, 3550, 4550, 5550, 6550, 7550, 8550, 9550, 10_000];

const provider: EmbeddingProvider = {
  kind: 'local',
  model: 'fake-lock',
  id: 'fake-lock',
  isAvailable: () => true,
  embed: async (texts) => texts.map((t) => hashedVector(t)),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('embedAll waiting on a held embedding index lock', () => {
  it('backs off from 50 ms to 1 s between asks and stops at the deadline', async () => {
    const root = makeRoot('embed-lock-backoff');
    const held = takeFileLock(join(root, 'embeddings.lock.db'));
    expect(held.kind).toBe('taken');
    const index = storeAt(root).hippoDb.embeddingIndex;
    vi.useFakeTimers({ now: Date.parse('2026-01-15T00:00:00.000Z') });
    const startedAt = Date.now();
    const asked: number[] = [];
    const step: EmbeddingIndex['step'] = (id, step) => {
      if (step.kind === 'lock') asked.push(Date.now() - startedAt);
      return index.step(id, step);
    };

    const run = embedAll(
      {
        embeddingIndex: { ...index, step },
        rows: storeAt(root),
        embeddings: loadConfig(root).embeddings,
        embedderFor: resolveEmbeddingProvider,
        failureNotices: new FailureNotices(),
      },
      undefined,
      provider,
    );
    const refused = expect(run).rejects.toThrow('the embedding index is busy');
    await vi.advanceTimersByTimeAsync(10_000);
    await refused;

    expect(asked).toEqual(ASKED_AT_MS);
    if (held.kind === 'taken') held.lock.release();
  });
});
