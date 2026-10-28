// The index adapter and the store adapter wait on one queue per index key, so an embed through each
// on one root never overlaps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailureNotices } from '../../src/base/util/failure-notices.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import type { IndexEmbedTarget } from '../../src/domain/search/embed-index-target.js';
import type { StoreEmbedTarget } from '../../src/domain/search/embed-store-target.js';
import { partialFake } from '../_helpers/partial-fake.js';
import { embedTurns } from '../../src/domain/search/embed-turns.js';
import { evalNow } from '../../src/infra/eval-switches.js';

const KEY = 'one-root';
const provider: EmbeddingProvider = {
  kind: 'local',
  model: 'm',
  id: 'm',
  isAvailable: () => true,
  embed: async () => [],
};
const common = {
  embeddings: {},
  embedderFor: () => provider,
  failureNotices: new FailureNotices(),
} as const;

describe('embed adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hold one turn per index key across the index adapter and the store adapter', async () => {
    let indexTouched = 0;
    let storeTouched = 0;
    let touch: () => void = () => undefined;
    const anyTouch = new Promise<void>((resolve) => (touch = resolve));
    const indexOn = partialFake<IndexEmbedTarget>()({
      ...common,
      rows: { entriesByIds: async () => [] },
      embeddingIndex: {
        open: async () => ({ id: '1', key: KEY }),
        step: async () => {
          indexTouched += 1;
          touch();
          throw new Error('stop after the first step');
        },
      },
    });
    const storeOn = partialFake<StoreEmbedTarget>()({
      ...common,
      strength: PRODUCTION_STRENGTH,
      clock: evalNow,
      groups: {
        vectorWrites: { indexKey: async () => KEY },
        vectors: {
          embeddingIndexState: async () => {
            storeTouched += 1;
            touch();
            throw new Error('stop after the first read');
          },
        },
      },
    });
    let release: () => void = () => undefined;
    const held = embedTurns.run(KEY, () => new Promise<void>((resolve) => (release = resolve)));
    // Each adapter that takes the turn joins the queue behind the held one; one that skips it touches its target at once.
    const queued = new Promise<void>((resolve) => {
      let joined = 0;
      const run = embedTurns.run.bind(embedTurns);
      vi.spyOn(embedTurns, 'run').mockImplementation((key, job) => {
        if (key === KEY && ++joined === 2) resolve();
        return run(key, job);
      });
    });
    const runs = Promise.allSettled([embedAll(indexOn), embedAll(storeOn)]);
    await Promise.race([queued, anyTouch]);
    expect({ indexTouched, storeTouched }).toEqual({ indexTouched: 0, storeTouched: 0 });
    release();
    await held;
    await runs;
    expect(indexTouched).toBeGreaterThan(0);
    expect(storeTouched).toBeGreaterThan(0);
  });
});
