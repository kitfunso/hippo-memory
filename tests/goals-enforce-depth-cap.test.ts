/**
 * v1.7.4 — enforceDepthCapWithinTx helper extracted from pushGoalWithDb and
 * resumeGoal. Pure refactor: pin behaviour with a direct test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { initStore } from '../src/store.js';
import { pushGoal, enforceDepthCapWithinTx, MAX_ACTIVE_GOAL_DEPTH } from '../src/goals.js';

describe('enforceDepthCapWithinTx helper (v1.7.4)', () => {
  let hippoRoot: string;
  const tenantId = 'default';
  const sessionId = 'sess-cap';

  beforeEach(async () => {
    hippoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hippo-1.7.4-'));
    initStore(hippoRoot);
  });

  it('no-op when active goal count is below cap (caller in BEGIN IMMEDIATE)', () => {
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'g1' });
    const db = openHippoDb(hippoRoot);
    try {
      // Helper requires caller-managed transaction. Wrap explicitly so the
      // test does NOT normalize unsafe out-of-tx usage (codex P1 finding).
      db.exec('BEGIN IMMEDIATE');
      try {
        enforceDepthCapWithinTx(db, tenantId, sessionId);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      const active = db.prepare(
        `SELECT COUNT(*) AS c FROM goal_stack WHERE status = 'active' AND tenant_id = ? AND session_id = ?`,
      ).get(tenantId, sessionId) as { c: number };
      expect(active.c).toBe(1); // unchanged
    } finally {
      closeHippoDb(db);
    }
  });

  it('suspends the oldest active goal when at cap (caller in BEGIN IMMEDIATE)', () => {
    for (let i = 0; i < MAX_ACTIVE_GOAL_DEPTH; i++) {
      pushGoal(hippoRoot, { sessionId, tenantId, goalName: `g${i}` });
    }
    const db = openHippoDb(hippoRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        enforceDepthCapWithinTx(db, tenantId, sessionId);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      const active = db.prepare(
        `SELECT COUNT(*) AS c FROM goal_stack WHERE status = 'active' AND tenant_id = ? AND session_id = ?`,
      ).get(tenantId, sessionId) as { c: number };
      expect(active.c).toBe(MAX_ACTIVE_GOAL_DEPTH - 1);
    } finally {
      closeHippoDb(db);
    }
  });
});
