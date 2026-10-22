// Embedding writes wait on each other per hippo.db: two folders embed at once, two handles on one folder take turns.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/base/config/config.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import { cliStore } from '../../src/surface/cli/api-context.js';
import { hashedVector } from '../_helpers/hashed-embedding-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

/** A provider that counts the embed calls in flight; `hold` keeps each one open until it returns. */
function countingProvider(hold: (seen: { active: number; peak: number }) => Promise<void>) {
  const seen = { active: 0, peak: 0 };
  const provider: EmbeddingProvider = {
    kind: 'local',
    model: 'fake-queue',
    id: 'fake-queue',
    isAvailable: () => true,
    embed: async (texts) => {
      seen.active += 1;
      seen.peak = Math.max(seen.peak, seen.active);
      try {
        await hold(seen);
      } finally {
        seen.active -= 1;
      }
      return texts.map((t) => hashedVector(t));
    },
  };
  return { provider, seen };
}

function targetOn(root: string, provider: EmbeddingProvider) {
  return {
    embeddingIndex: cliStore(root).embeddingIndex,
    rows: cliStore(root),
    embeddings: loadConfig(root).embeddings,
    embedderFor: () => provider,
  };
}

const seed = (root: string, text: string): void => writeEntry(root, createMemory(text));

describe('embedding writes', () => {
  it('run at the same time for two folders in one process', async () => {
    const [rootA, rootB] = [makeRoot('embed-queue-a'), makeRoot('embed-queue-b')];
    seed(rootA, 'the first folder holds a note about harbour tides');
    seed(rootB, 'the second folder holds a note about mountain passes');
    // Each embed call waits for the other, so a lock shared by both folders would leave them waiting for ever.
    let release!: () => void;
    const bothIn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, seen } = countingProvider(async (now) => {
      if (now.active === 2) release();
      await bothIn;
    });

    await Promise.all([embedAll(targetOn(rootA, provider)), embedAll(targetOn(rootB, provider))]);

    expect(seen.peak).toBe(2);
  }, 20_000);

  it('take turns across two handles on one folder', async () => {
    const root = makeRoot('embed-queue-shared');
    seed(root, 'one folder holds a note about river bridges');
    seed(root, 'the same folder holds a note about canal locks');
    const { provider, seen } = countingProvider(() => new Promise((resolve) => setTimeout(resolve, 30)));

    await Promise.all([embedAll(targetOn(root, provider)), embedAll(targetOn(root, provider))]);

    expect(seen.peak).toBe(1);
  }, 20_000);
});
