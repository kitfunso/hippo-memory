/**
 * Runtime test for v1.11.5: lock the api.recall last_retrieval_ids divergence
 * from cmdRecall.
 *
 * Contract:
 *   - api.recall(ctx, opts) is a READ — it does NOT mutate
 *     index.last_retrieval_ids.
 *   - api.getContext(ctx, opts) DOES write last_retrieval_ids (used by
 *     the SDK's outcome-after-context workflow).
 *   - The CLI cmdRecall (cli.ts:1282 region) also writes last_retrieval_ids
 *     because the CLI is interactive — user is about to run
 *     `hippo outcome --good`. This divergence is documented in api.recall's
 *     JSDoc and python/README.md Limitations.
 *
 * Adding the side-effect to api.recall would break SDK callers that batch
 * recall calls in a row (each would overwrite the last). Locked by this
 * test so future "make api.recall write the ids too" attempts trip CI.
 *
 * Real-DB per project convention.
 */

import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { loadLastRecall } from '../src/store/index-and-stats.js';
import { remember, retrieve, getContext } from '../src/api/index.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { makeRoot } from './_helpers/make-root.js';

function tmpHome() {
  const home = makeRoot('api-recall-noside');
  const origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = home;
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
      if (origHippoHome !== undefined) {
        process.env.HIPPO_HOME = origHippoHome;
      } else {
        delete process.env.HIPPO_HOME;
      }
    },
  };
}

describe('api.recall divergence from cmdRecall (no last_retrieval_ids side-effect)', () => {
  it('api.recall does NOT write last_retrieval_ids; api.getContext DOES', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'recall-divergence-target-1' });
      await remember(ctx, { content: 'recall-divergence-target-2 also matches' });

      // Snapshot: index.last_retrieval_ids starts empty.
      const before = loadLastRecall(home).last_retrieval_ids ?? [];
      expect(before).toEqual([]);

      // api.recall — should NOT mutate.
      const recallResult = await retrieve(ctx, { query: 'target', limit: 5 });
      expect(recallResult.results.length).toBeGreaterThan(0);
      const afterRecall = loadLastRecall(home).last_retrieval_ids ?? [];
      expect(afterRecall).toEqual(before);
      expect(afterRecall).toEqual([]);

      // api.getContext — SHOULD mutate. (getContext opts use `q`, not `query`.)
      const ctxResult = await getContext(ctx, { q: 'target', budget: 1000 });
      expect(ctxResult.entries.length).toBeGreaterThan(0);
      const afterContext = loadLastRecall(home).last_retrieval_ids ?? [];
      expect(afterContext.length).toBeGreaterThan(0);
      expect(afterContext).not.toEqual(before);
    } finally {
      restore();
    }
  });

  it('batched api.recall calls leave last_retrieval_ids untouched (no overwrite race)', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'batched-A' });
      await remember(ctx, { content: 'batched-B' });
      await remember(ctx, { content: 'batched-C' });

      // SDK pattern: batch many recall calls in a row.
      await retrieve(ctx, { query: 'batched-A', limit: 5 });
      await retrieve(ctx, { query: 'batched-B', limit: 5 });
      await retrieve(ctx, { query: 'batched-C', limit: 5 });

      // last_retrieval_ids must remain empty — none of the recalls wrote it.
      const idx = loadLastRecall(home);
      expect(idx.last_retrieval_ids ?? []).toEqual([]);
    } finally {
      restore();
    }
  });
});
