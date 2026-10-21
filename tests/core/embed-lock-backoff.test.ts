// An embed run that finds the index's lock held asks again at a doubling interval, capped at a second, and gives up
// on the 10 s deadline: 15 asks in the budget, not one every 50 ms.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/base/config/config.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import { cliStore } from '../../src/surface/cli/api-context.js';
import { hashedVector } from '../_helpers/hashed-embedding-server.js';
import { makeRoot } from '../_helpers/make-root.js';

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
    // The parent process is alive for the whole test, so the lock reads as another live holder's.
    writeFileSync(join(root, 'embeddings.lock'), `${process.ppid}:held`);
    const index = cliStore(root).embeddingIndex;
    vi.useFakeTimers({ now: Date.parse('2026-01-15T00:00:00.000Z') });
    const startedAt = Date.now();
    const asked: number[] = [];
    const tryLock = async (): Promise<string | null> => {
      asked.push(Date.now() - startedAt);
      return index.tryLock();
    };

    const run = embedAll(
      {
        embeddingIndex: { ...index, tryLock },
        embeddings: loadConfig(root).embeddings,
        embedderFor: resolveEmbeddingProvider,
      },
      undefined,
      provider,
    );
    const refused = expect(run).rejects.toThrow('the embedding index is busy');
    await vi.advanceTimersByTimeAsync(10_000);
    await refused;

    expect(asked).toEqual(ASKED_AT_MS);
  });
});
