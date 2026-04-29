// tests/b3-goal-lifecycle.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { pushGoal, completeGoal, suspendGoal, resumeGoal, getActiveGoals } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('goal lifecycle', () => {
  let root: string;
  const ctx = { sessionId: 's1', tenantId: 'default' };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-life-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('completeGoal sets status, completed_at, outcome_score', () => {
    const g = pushGoal(root, { ...ctx, goalName: 'work' });
    completeGoal(root, g.id, { outcomeScore: 0.85 });
    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT status, completed_at, outcome_score FROM goal_stack WHERE id = ?`).get(g.id) as { status: string; completed_at: string; outcome_score: number };
      expect(row.status).toBe('completed');
      expect(row.completed_at).toBeTruthy();
      expect(row.outcome_score).toBe(0.85);
    } finally {
      closeHippoDb(db);
    }
    expect(getActiveGoals(root, ctx)).toHaveLength(0);
  });

  it('suspend/resume cycles status; cap applies on resume', () => {
    const a = pushGoal(root, { ...ctx, goalName: 'a' });
    pushGoal(root, { ...ctx, goalName: 'b' });
    pushGoal(root, { ...ctx, goalName: 'c' });
    suspendGoal(root, a.id);
    expect(getActiveGoals(root, ctx)).toHaveLength(2);
    pushGoal(root, { ...ctx, goalName: 'd' });
    expect(getActiveGoals(root, ctx)).toHaveLength(3);
    resumeGoal(root, a.id);
    const names = getActiveGoals(root, ctx).map((g) => g.goalName).sort();
    expect(names).toContain('a');
    expect(names).toHaveLength(3);
  });

  it('completeGoal on a suspended goal still works', () => {
    const g = pushGoal(root, { ...ctx, goalName: 'sus-then-done' });
    suspendGoal(root, g.id);
    completeGoal(root, g.id, { outcomeScore: 0.5 });
    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT status FROM goal_stack WHERE id = ?`).get(g.id) as { status: string };
      expect(row.status).toBe('completed');
    } finally {
      closeHippoDb(db);
    }
  });
});
