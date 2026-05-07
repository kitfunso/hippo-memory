// tests/goals-complete-no-propagate.test.ts
/**
 * v1.7.4 -- `completeGoal` honours `noPropagate` to skip strength
 * multiplier side-effects on recalled memories.
 *
 * Implementation note (option 2 from plan Task 2): the plan's reference
 * tests call `recall(ctx, { query: 'auth', sessionId })` which depends on
 * `RecallOpts.sessionId` being added by Task 1. Task 1 is not yet shipped,
 * so we seed `goal_recall_log` directly (mirroring the existing
 * `b3-outcome-propagation.test.ts` pattern via `seedRecallLog`). This
 * makes Task 2 tests independent of Task 1 and exercises the propagation
 * block deterministically without relying on the boost helper to populate
 * the log row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { remember, type Context } from '../src/api.js';
import { pushGoal, completeGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const tenantId = 'default';
const sessionId = 'sess-no-prop';

function ctx(root: string): Context {
  return { hippoRoot: root, tenantId, actor: 'cli' };
}

function getStrength(root: string, memId: string): number {
  const db = openHippoDb(root);
  try {
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

describe('completeGoal noPropagate flag (v1.7.4)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-1.7.4-noprop-'));
    initStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('default propagates strength multiplier on positive outcome', () => {
    const m = remember(ctx(root), { content: 'fix auth bug', tags: ['fix-auth'] });
    // Default strength is 1.0 (ceiling); knock it down so the 1.10x boost shows.
    setStrength(root, m.id, 0.5);
    const goal = pushGoal(root, { sessionId, tenantId, goalName: 'fix-auth' });
    seedRecallLog(root, goal.id, m.id, new Date().toISOString());
    const beforeStrength = getStrength(root, m.id);
    completeGoal(root, goal.id, { outcomeScore: 1.0 }); // positive outcome
    const afterStrength = getStrength(root, m.id);
    expect(afterStrength).toBeGreaterThan(beforeStrength);
  });

  it('noPropagate skips strength side-effects', () => {
    const m = remember(ctx(root), { content: 'fix auth bug', tags: ['fix-auth'] });
    setStrength(root, m.id, 0.5);
    const goal = pushGoal(root, { sessionId, tenantId, goalName: 'fix-auth' });
    seedRecallLog(root, goal.id, m.id, new Date().toISOString());
    const beforeStrength = getStrength(root, m.id);
    completeGoal(root, goal.id, { outcomeScore: 1.0, noPropagate: true });
    const afterStrength = getStrength(root, m.id);
    expect(afterStrength).toBe(beforeStrength); // unchanged
  });

  it('second call with noPropagate is a true no-op after first call propagated (idempotency)', () => {
    // Status check at src/goals.ts:253-257 short-circuits the second call BEFORE
    // reading opts.noPropagate. So a second call with noPropagate after a propagating
    // first call leaves strength as the post-first-call value (propagation already
    // happened on call 1; call 2 is a no-op regardless of noPropagate).
    const m = remember(ctx(root), { content: 'fix auth bug', tags: ['fix-auth'] });
    setStrength(root, m.id, 0.5);
    const goal = pushGoal(root, { sessionId, tenantId, goalName: 'fix-auth' });
    seedRecallLog(root, goal.id, m.id, new Date().toISOString());
    completeGoal(root, goal.id, { outcomeScore: 1.0 }); // call 1: propagates
    const afterFirstCall = getStrength(root, m.id);
    completeGoal(root, goal.id, { outcomeScore: 1.0, noPropagate: true }); // call 2
    expect(getStrength(root, m.id)).toBe(afterFirstCall); // call 2 is a no-op
  });
});
