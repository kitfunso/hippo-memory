import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { remember, retrieve, contextGet } from '../../src/api/index.js';
import { apiCtx, cwdProject } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadLastRecall } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function tmpHome() {
  const home = makeRoot('api-recall-noside');
  vi.stubEnv('HIPPO_HOME', home);
  return {
    home,
    restore: () => {
      removeDir(home);
    },
  };
}

describe('api.recall divergence from printRecall (no last_retrieval_ids side-effect)', () => {
  it('api.recall does NOT write last_retrieval_ids; api.contextGet DOES', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      await remember(ctx, { content: 'recall-divergence-target-1' });
      await remember(ctx, { content: 'recall-divergence-target-2 also matches' });

      const before = loadLastRecall(home).last_retrieval_ids ?? [];
      expect(before).toEqual([]);

      const recallResult = await retrieve(ctx, { query: 'target', window: { limit: 5 } });
      expect(recallResult.results).toHaveLength(2);
      const afterRecall = loadLastRecall(home).last_retrieval_ids ?? [];
      expect(afterRecall).toEqual(before);
      expect(afterRecall).toEqual([]);

      const ctxResult = await contextGet(ctx, { currentProject: cwdProject(), q: 'target', budget: 1000 });
      expect(ctxResult.entries).toHaveLength(2);
      const afterContext = loadLastRecall(home).last_retrieval_ids ?? [];
      expect([...afterContext].sort()).toEqual(ctxResult.entries.map((e) => e.entry.id).sort());
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

      await retrieve(ctx, { query: 'batched-A', window: { limit: 5 } });
      await retrieve(ctx, { query: 'batched-B', window: { limit: 5 } });
      await retrieve(ctx, { query: 'batched-C', window: { limit: 5 } });

      const idx = loadLastRecall(home);
      expect(idx.last_retrieval_ids ?? []).toEqual([]);
    } finally {
      restore();
    }
  });
});
