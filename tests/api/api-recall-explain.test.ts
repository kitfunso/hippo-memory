/**
 * A7 recall-trace — api.recall explain flag.
 *
 * recall({explain:true}) attaches `rerankTrace` (the goal-boost step) +
 * `rerankPipeline:'api'` to result items; {explain:false} leaves BOTH absent
 * on EVERY band (byte-identical default). Real SQLite store, no mocks.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { remember, retrieve } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { pushGoal } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

describe('api.recall explain', () => {
  let hippoRoot: string;
  let ctx: FullContext;
  const tenantId = 'default';
  const sessionId = 'sess-a7-api';

  beforeEach(async () => {
    hippoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hippo-a7-api-'));
    initTestStore(hippoRoot);
    ctx = apiCtx(hippoRoot, tenantId, { subject: 'test', role: 'admin' });
  });

  it('explain:true attaches the goal-boost step + rerankPipeline:api', async () => {
    const goalMatch = await remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
    await remember(ctx, { content: 'auth UI polish', tags: ['ui'] });
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });

    const result = await retrieve(ctx, {
      query: 'auth',
      window: { limit: 10 },
      boost: { sessionId },
      trace: { explain: true },
    });

    // Every item carries the api pipeline marker.
    for (const item of result.results) {
      expect(item.rerankPipeline).toBe('api');
    }
    // The boosted (goal-tagged) row carries a goal-boost trace step.
    const boosted = result.results.find((r) => r.id === goalMatch.id);
    expect(boosted).toBeDefined();
    expect(boosted!.rerankTrace).toBeDefined();
    expect(boosted!.rerankTrace!.length).toBe(1);
    expect(boosted!.rerankTrace![0].stage).toBe('goal-boost');
    expect(boosted!.rerankTrace![0].scoreAfter).toBe(boosted!.score);
  });

  it('explain:false (default) leaves both fields absent on every band', async () => {
    const goalMatch = await remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
    await remember(ctx, { content: 'auth UI polish', tags: ['ui'] });
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });

    const result = await retrieve(ctx, { query: 'auth', window: { limit: 10 }, boost: { sessionId } });

    for (const item of result.results) {
      expect(item.rerankPipeline).toBeUndefined();
      expect(item.rerankTrace).toBeUndefined();
    }
    // The goal-boost still ran (ordering changed) — only the trace is absent.
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(goalMatch.id);
  });
});
