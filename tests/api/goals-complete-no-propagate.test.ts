import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { remember } from '../../src/api/index.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { pushGoal, completeGoal } from '../_helpers/root-forms.js';

const tenantId = 'default';
const sessionId = 'sess-no-prop';

function ctx(root: string): FullContext {
  return apiCtx(root, tenantId, { subject: 'cli', role: 'admin' });
}

function getStrength(root: string, memId: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: memId is always a row this test wrote earlier via remember()/
    // writeEntry(), so the SELECT by primary key always returns exactly one
    // row with a strength column.
    const row = db.prepare('SELECT strength FROM memories WHERE id = ?').get(memId) as { strength: number };
    return row.strength;
  } finally {
    closeHippoDb(db);
  }
}

function setStrength(root: string, memId: string, strength: number): void {
  const db = openHippoDb(root);
  try {
    db.prepare('UPDATE memories SET strength = ? WHERE id = ?').run(strength, memId);
  } finally {
    closeHippoDb(db);
  }
}

function seedRecallLog(root: string, goalId: string, memoryId: string, recalledAt: string): void {
  const db = openHippoDb(root);
  try {
    db.prepare(
      `INSERT INTO goal_recall_log (goal_id, memory_id, tenant_id, session_id, recalled_at, score)
       VALUES (?, ?, ?, ?, ?, 1.0)`,
    ).run(goalId, memoryId, tenantId, sessionId, recalledAt);
  } finally {
    closeHippoDb(db);
  }
}

describe('completeGoal noPropagate flag', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('1.7.4-noprop');
  });

  it('default propagates strength multiplier on positive outcome', async () => {
    const m = await remember(ctx(root), { content: 'fix auth bug', tags: ['fix-auth'] });
    setStrength(root, m.id, 0.5);
    const goal = await pushGoal(root, { sessionId, tenantId, goalName: 'fix-auth' });
    seedRecallLog(root, goal.id, m.id, new Date().toISOString());
    const beforeStrength = getStrength(root, m.id);
    await completeGoal(root, goal.id, { outcomeScore: 1.0 });
    const afterStrength = getStrength(root, m.id);
    expect(afterStrength).toBeGreaterThan(beforeStrength);
  });

  it('noPropagate skips strength side-effects', async () => {
    const m = await remember(ctx(root), { content: 'fix auth bug', tags: ['fix-auth'] });
    setStrength(root, m.id, 0.5);
    const goal = await pushGoal(root, { sessionId, tenantId, goalName: 'fix-auth' });
    seedRecallLog(root, goal.id, m.id, new Date().toISOString());
    const beforeStrength = getStrength(root, m.id);
    await completeGoal(root, goal.id, { outcomeScore: 1.0, noPropagate: true });
    const afterStrength = getStrength(root, m.id);
    expect(afterStrength).toBe(beforeStrength);
  });

  it('second call with noPropagate is a true no-op after first call propagated (idempotency)', async () => {
    const m = await remember(ctx(root), { content: 'fix auth bug', tags: ['fix-auth'] });
    setStrength(root, m.id, 0.5);
    const goal = await pushGoal(root, { sessionId, tenantId, goalName: 'fix-auth' });
    seedRecallLog(root, goal.id, m.id, new Date().toISOString());
    await completeGoal(root, goal.id, { outcomeScore: 1.0 });
    const afterFirstCall = getStrength(root, m.id);
    await completeGoal(root, goal.id, { outcomeScore: 1.0, noPropagate: true });
    expect(getStrength(root, m.id)).toBe(afterFirstCall);
  });
});
