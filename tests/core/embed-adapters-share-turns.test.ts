// The index adapter and the store adapter wait on one queue per index key, so an embed through each
// on one root never overlaps.
import { describe, expect, it } from 'vitest';
import { FailureNotices } from '../../src/base/util/failure-notices.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { embedAll, type EmbedTarget } from '../../src/domain/search/embed-memories.js';
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
  it('hold one turn per index key across the index adapter and the store adapter', async () => {
    let indexTouched = 0;
    let storeTouched = 0;
    // SAFETY: only the calls this adapter makes before the first step are faked.
    const indexOn: EmbedTarget = {
      ...common,
      rows: { entriesByIds: async () => [] },
      embeddingIndex: {
        open: async () => ({ id: 1, key: KEY }),
        step: async () => {
          indexTouched += 1;
          throw new Error('stop after the first step');
        },
      },
    } as never;
    // SAFETY: only the calls this adapter makes before the first read are faked.
    const storeOn: EmbedTarget = {
      ...common,
      strength: PRODUCTION_STRENGTH,
      clock: evalNow,
      groups: {
        vectorWrites: { indexKey: async () => KEY },
        vectors: {
          embeddingIndexState: async () => {
            storeTouched += 1;
            throw new Error('stop after the first read');
          },
        },
      },
    } as never;
    let release: () => void = () => undefined;
    const held = embedTurns.run(KEY, () => new Promise<void>((resolve) => (release = resolve)));
    const runs = Promise.allSettled([embedAll(indexOn), embedAll(storeOn)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({ indexTouched, storeTouched }).toEqual({ indexTouched: 0, storeTouched: 0 });
    release();
    await held;
    await runs;
    expect(indexTouched).toBeGreaterThan(0);
    expect(storeTouched).toBeGreaterThan(0);
  });
});
