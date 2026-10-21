// tests/store/goal-lifecycle.test.ts
import { describe, it, expect, beforeEach } from 'vitest';

const activeGoalsOf = (root: string, opts: { sessionId: string; tenantId: string }) =>
  activeGoalsWithPolicies(root, opts).goals;
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { activeGoalsWithPolicies, pushGoal, completeGoal, suspendGoal } from '../_helpers/root-forms.js';

describe('goal lifecycle', () => {
  let root: string;
  const ctx = { sessionId: 's1', tenantId: 'default' };
  beforeEach(() => {
    root = makeRoot('b3-life');
  });

  it('completeGoal sets status, completed_at, outcome_score', () => {
    const g = pushGoal(root, { ...ctx, goalName: 'work' });
    completeGoal(root, g.id, { outcomeScore: 0.85 });
    const db = openHippoDb(root);
    try {
      // SAFETY: the goal_stack table's status/completed_at/outcome_score columns are
      // TEXT/TEXT/REAL per the migration in src/db/index.ts; this query selects exactly
      // those three columns for a single row by primary key.
      const row = db.prepare(`SELECT status, completed_at, outcome_score FROM goal_stack WHERE id = ?`).get(g.id) as {
        status: string;
        completed_at: string;
        outcome_score: number;
      };
      expect(row.status).toBe('completed');
      expect(row.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(row.outcome_score).toBe(0.85);
    } finally {
      closeHippoDb(db);
    }
    expect(activeGoalsOf(root, ctx)).toHaveLength(0);
  });

  it('completeGoal on a suspended goal still works', () => {
    const g = pushGoal(root, { ...ctx, goalName: 'sus-then-done' });
    suspendGoal(root, g.id);
    completeGoal(root, g.id, { outcomeScore: 0.5 });
    const db = openHippoDb(root);
    try {
      // SAFETY: status is a TEXT column on goal_stack per the migration in src/db/index.ts;
      // this query selects exactly that one column for a single row by primary key.
      const row = db.prepare(`SELECT status FROM goal_stack WHERE id = ?`).get(g.id) as { status: string };
      expect(row.status).toBe('completed');
    } finally {
      closeHippoDb(db);
    }
  });
});
