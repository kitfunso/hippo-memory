// tests/store/goal-lifecycle.test.ts
import { describe, it, expect, beforeEach } from 'vitest';

const activeGoalsOf = (root: string, opts: { sessionId: string; tenantId: string }) =>
  activeGoalsWithPolicies(root, opts).goals;
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  activeGoalsWithPolicies,
  pushGoal,
  completeGoal,
  suspendGoal,
  resumeGoal,
  readEntry,
  writeEntry,
} from '../_helpers/root-forms.js';
import { onHandle, sqliteStore } from '../_helpers/test-session.js';
import { createMemory } from '../../src/entry/memory.js';
import { writeGoalRecallLog } from '../../src/store/sqlite/sessions/goals.js';

describe('goal lifecycle', () => {
  let root: string;
  const ctx = { sessionId: 's1', tenantId: 'default' };
  beforeEach(() => {
    root = makeRoot('b3-life');
  });

  const goalsOf = () => sqliteStore(root).goals.sessionGoals(ctx.tenantId, ctx.sessionId);
  const statusesOf = async () => (await goalsOf()).map((g) => g.status);
  const goalById = async (id: string) => (await goalsOf()).find((g) => g.id === id);
  const strengthOf = (id: string) => readEntry(root, id, ctx.tenantId)?.strength;
  // Completing the goal rescales the memories its recall log names, inside the goal's active life.
  const recalledUnder = (goalId: string, strength: number): string => {
    const entry = { ...createMemory('recalled under the goal', { tenantId: ctx.tenantId }), strength };
    writeEntry(root, entry);
    const recalledAt = new Date().toISOString();
    const row = { goalId, memoryId: entry.id, tenantId: ctx.tenantId, sessionId: ctx.sessionId, recalledAt, score: 1 };
    onHandle(root, (db) => writeGoalRecallLog(db, [row]));
    return entry.id;
  };

  it('completeGoal sets status, completed_at, outcome_score', async () => {
    const g = await pushGoal(root, { ...ctx, goalName: 'work' });
    await completeGoal(root, g.id, { outcomeScore: 0.85 });
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

  it('completeGoal on a suspended goal still works', async () => {
    const g = await pushGoal(root, { ...ctx, goalName: 'sus-then-done' });
    await suspendGoal(root, g.id);
    await completeGoal(root, g.id, { outcomeScore: 0.5 });
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

  it('completeGoal from active sets the outcome score and rescales a recalled memory once', async () => {
    const g = await pushGoal(root, { ...ctx, goalName: 'work' });
    const memory = recalledUnder(g.id, 0.5);
    await completeGoal(root, g.id, { outcomeScore: 0.9 });
    expect(await goalById(g.id)).toMatchObject({ status: 'completed', outcomeScore: 0.9 });
    expect(strengthOf(memory)).toBeCloseTo(0.55);
  });

  it('completeGoal from suspended sets the outcome score and rescales a recalled memory once', async () => {
    const g = await pushGoal(root, { ...ctx, goalName: 'work' });
    const memory = recalledUnder(g.id, 0.5);
    await suspendGoal(root, g.id);
    await completeGoal(root, g.id, { outcomeScore: 0.9 });
    expect(await goalById(g.id)).toMatchObject({ status: 'completed', outcomeScore: 0.9 });
    expect(strengthOf(memory)).toBeCloseTo(0.55);
  });

  it('completeGoal on a completed goal keeps its stamp and score and rescales nothing', async () => {
    const g = await pushGoal(root, { ...ctx, goalName: 'work' });
    const memory = recalledUnder(g.id, 0.5);
    await completeGoal(root, g.id, { outcomeScore: 0.9 });
    const completed = await goalById(g.id);
    const rescaled = strengthOf(memory);
    await completeGoal(root, g.id, { outcomeScore: 0.1 });
    expect(await goalById(g.id)).toEqual(completed);
    expect(strengthOf(memory)).toBe(rescaled);
  });

  it('resumeGoal moves a suspended goal to active', async () => {
    const g = await pushGoal(root, { ...ctx, goalName: 'work' });
    await suspendGoal(root, g.id);
    await resumeGoal(root, g.id);
    expect(await statusesOf()).toEqual(['active']);
  });

  // These two rows prove the in-scope status read; the guard under it is proved in status-transition-guard.test.ts.
  it('resumeGoal on an active goal changes nothing, so the depth cap suspends no other goal', async () => {
    await pushGoal(root, { ...ctx, goalName: 'a' });
    await pushGoal(root, { ...ctx, goalName: 'b' });
    const c = await pushGoal(root, { ...ctx, goalName: 'c' });
    await resumeGoal(root, c.id);
    expect(await statusesOf()).toEqual(['active', 'active', 'active']);
  });

  it('resumeGoal on a completed goal changes nothing, so the depth cap suspends no other goal', async () => {
    const a = await pushGoal(root, { ...ctx, goalName: 'a' });
    await pushGoal(root, { ...ctx, goalName: 'b' });
    await pushGoal(root, { ...ctx, goalName: 'c' });
    await completeGoal(root, a.id, { outcomeScore: 0.5 });
    await pushGoal(root, { ...ctx, goalName: 'd' });
    await resumeGoal(root, a.id);
    expect(await statusesOf()).toEqual(['completed', 'active', 'active', 'active']);
  });
});
