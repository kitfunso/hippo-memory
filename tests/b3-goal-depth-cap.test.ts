import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { pushGoal, getActiveGoals, MAX_ACTIVE_GOAL_DEPTH } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('goal stack depth cap', () => {
  let root: string;
  const ctx = { sessionId: 's1', tenantId: 'default' };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-cap-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exposes MAX_ACTIVE_GOAL_DEPTH = 3', () => {
    expect(MAX_ACTIVE_GOAL_DEPTH).toBe(3);
  });

  it('auto-suspends the oldest active goal when pushing the 4th', () => {
    const g1 = pushGoal(root, { ...ctx, goalName: 'oldest' });
    pushGoal(root, { ...ctx, goalName: 'middle' });
    pushGoal(root, { ...ctx, goalName: 'recent' });
    pushGoal(root, { ...ctx, goalName: 'newest' });

    const active = getActiveGoals(root, ctx);
    expect(active).toHaveLength(3);
    expect(active.map((g) => g.goalName)).toEqual(['middle', 'recent', 'newest']);

    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT status FROM goal_stack WHERE id = ?`).get(g1.id) as { status: string };
      expect(row.status).toBe('suspended');
    } finally {
      closeHippoDb(db);
    }
  });

  it('cap is per-(tenant, session)', () => {
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A1' });
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A2' });
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A3' });
    pushGoal(root, { sessionId: 's2', tenantId: 'default', goalName: 'B1' });
    pushGoal(root, { sessionId: 's1', tenantId: 't2', goalName: 'C1' });
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 'default' })).toHaveLength(3);
    expect(getActiveGoals(root, { sessionId: 's2', tenantId: 'default' })).toHaveLength(1);
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 't2' })).toHaveLength(1);
  });

  it('serialized pushes never leave more than 3 active (post-Task-3 BEGIN IMMEDIATE)', () => {
    // Sequential is enough to verify the invariant — node:sqlite is in-process,
    // and BEGIN IMMEDIATE serializes through SQLite's write lock. This guards
    // against regressions where someone strips the transaction wrapper.
    for (let i = 0; i < 10; i++) {
      pushGoal(root, { ...ctx, goalName: `g${i}` });
    }
    expect(getActiveGoals(root, ctx)).toHaveLength(3);
    const db = openHippoDb(root);
    try {
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM goal_stack`).get() as { c: number }).c;
      expect(total).toBe(10);
    } finally {
      closeHippoDb(db);
    }
  });
});
