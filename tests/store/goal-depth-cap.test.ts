import { describe, it, expect, beforeEach, vi } from 'vitest';

const activeGoalsOf = (root: string, opts: { sessionId: string; tenantId: string }) =>
  activeGoalsWithPolicies(root, opts).goals;
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { activeGoalsWithPolicies, pushGoal, resumeGoal, suspendGoal } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

describe('goal stack depth cap', () => {
  let root: string;
  const ctx = { sessionId: 's1', tenantId: 'default' };
  beforeEach(() => {
    root = makeRoot('b3-cap');
  });

  it('auto-suspends the oldest active goal when pushing the 4th, even when all share one created_at', async () => {
    // A frozen clock gives every push the same created_at, the tie fast pushes hit by chance.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    let g1: Awaited<ReturnType<typeof pushGoal>>;
    try {
      g1 = await pushGoal(root, { ...ctx, goalName: 'oldest' });
      await pushGoal(root, { ...ctx, goalName: 'middle' });
      await pushGoal(root, { ...ctx, goalName: 'recent' });
      await pushGoal(root, { ...ctx, goalName: 'newest' });
    } finally {
      vi.useRealTimers();
    }

    const active = activeGoalsOf(root, ctx);
    expect(active).toHaveLength(3);
    expect(active.map((g) => g.goalName)).toEqual(['middle', 'recent', 'newest']);

    const db = openHippoDb(root);
    try {
      // SAFETY: literal SELECT of the status column for the goal_stack row
      // this test's pushGoal calls above just wrote.
      const row = db.prepare(`SELECT status FROM goal_stack WHERE id = ?`).get(g1.id) as { status: string };
      expect(row.status).toBe('suspended');
    } finally {
      closeHippoDb(db);
    }
  });

  it('cap is per-(tenant, session)', async () => {
    await pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A1' });
    await pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A2' });
    await pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A3' });
    await pushGoal(root, { sessionId: 's2', tenantId: 'default', goalName: 'B1' });
    await pushGoal(root, { sessionId: 's1', tenantId: 't2', goalName: 'C1' });
    expect(activeGoalsOf(root, { sessionId: 's1', tenantId: 'default' })).toHaveLength(3);
    expect(activeGoalsOf(root, { sessionId: 's2', tenantId: 'default' })).toHaveLength(1);
    expect(activeGoalsOf(root, { sessionId: 's1', tenantId: 't2' })).toHaveLength(1);
  });

  it('serialized pushes never leave more than 3 active (post-Task-3 BEGIN IMMEDIATE)', async () => {
    // Sequential is enough to verify the invariant — node:sqlite is in-process,
    // and BEGIN IMMEDIATE serializes through SQLite's write lock. This guards
    // against regressions where someone strips the transaction wrapper.
    for (let i = 0; i < 10; i++) {
      await pushGoal(root, { ...ctx, goalName: `g${i}` });
    }
    expect(activeGoalsOf(root, ctx)).toHaveLength(3);
    const db = openHippoDb(root);
    try {
      // SAFETY: literal COUNT(*) query against the known goal_stack schema
      // always returns a single { c } row.
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM goal_stack`).get() as { c: number }).c;
      expect(total).toBe(10);
    } finally {
      closeHippoDb(db);
    }
  });

  it('suspends the oldest active goal when a resume would pass the cap', async () => {
    const goals = [];
    for (const goalName of ['g0', 'g1', 'g2']) goals.push(await pushGoal(root, { ...ctx, goalName }));
    await suspendGoal(root, goals[2]!.id);
    expect(activeGoalsOf(root, ctx)).toHaveLength(2);
    await pushGoal(root, { ...ctx, goalName: 'g3' });
    expect(activeGoalsOf(root, ctx)).toHaveLength(3);

    await resumeGoal(root, goals[2]!.id);
    const active = activeGoalsOf(root, ctx).map((g) => g.goalName);
    expect(active).toHaveLength(3);
    expect(active).not.toContain('g0');
    expect(active).toContain('g2');
  });
});
