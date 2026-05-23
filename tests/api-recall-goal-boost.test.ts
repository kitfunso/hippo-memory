/**
 * v1.7.4 -- api.recall plumbs RecallOpts.sessionId through to the
 * applyGoalStackBoost helper on its primary BM25 band, BEFORE projection to
 * RecallResultItem and BEFORE fresh-tail / summary appendix rows are
 * appended. Pinned end-to-end through the api surface (not through CLI/MCP/
 * HTTP -- those have their own integration tests).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initStore } from '../src/store.js';
import { remember, recall, type Context } from '../src/api.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('api.recall + RecallOpts.sessionId goal-stack boost (v1.7.4)', () => {
  let hippoRoot: string;
  let ctx: Context;
  const tenantId = 'default';
  const sessionId = 'sess-api-1.7.4';

  beforeEach(async () => {
    hippoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hippo-1.7.4-api-'));
    initStore(hippoRoot);
    ctx = { hippoRoot, tenantId, actor: { subject: 'test', role: 'admin' } };
  });

  it('boosts the goal-tagged memory above an unrelated, query-matching one when sessionId set', () => {
    // Both rows mention "auth" so BM25 surfaces both. Without the boost, the
    // ui-tagged row outranks (or ties) the goal-tagged one. With the boost,
    // fix-auth wins.
    const goalMatch = remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
    const unrelated = remember(ctx, { content: 'auth UI polish', tags: ['ui'] });
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });

    const result = recall(ctx, { query: 'auth', limit: 10, sessionId });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(goalMatch.id);
    expect(ids).toContain(unrelated.id);
    // goalMatch must outrank unrelated post-boost.
    expect(ids.indexOf(goalMatch.id)).toBeLessThan(ids.indexOf(unrelated.id));
  });

  it('writes a goal_recall_log row when sessionId set AND the boosted memory is local', () => {
    const goal = pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });
    const m = remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
    recall(ctx, { query: 'auth', limit: 10, sessionId });
    const db = openHippoDb(hippoRoot);
    try {
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE goal_id = ? AND memory_id = ?`,
      ).get(goal.id, m.id) as { c: number }).c;
      expect(count).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('goalTag override SUPPRESSES the boost (mirrors the CLI v0.38 goalTag === \'\' gate)', () => {
    // Sanity: same setup as the first test but with goalTag set.
    const goalMatch = remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
    const unrelated = remember(ctx, { content: 'auth UI polish', tags: ['ui'] });
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });
    const goal = pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'pin-this' });

    const result = recall(ctx, {
      query: 'auth',
      limit: 10,
      sessionId,
      goalTag: 'pin-this',
    });
    expect(result.results.some((r) => r.id === goalMatch.id)).toBe(true);
    expect(result.results.some((r) => r.id === unrelated.id)).toBe(true);
    // No goal_recall_log row written (boost suppressed).
    const db = openHippoDb(hippoRoot);
    try {
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE goal_id = ?`,
      ).get(goal.id) as { c: number }).c;
      expect(count).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('omitting sessionId preserves v1.7.3 behaviour (no boost, no log)', () => {
    const goal = pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });
    const m = remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
    recall(ctx, { query: 'auth', limit: 10 }); // no sessionId
    const db = openHippoDb(hippoRoot);
    try {
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE goal_id = ? AND memory_id = ?`,
      ).get(goal.id, m.id) as { c: number }).c;
      expect(count).toBe(0); // no boost, no log row
    } finally {
      closeHippoDb(db);
    }
  });
});
