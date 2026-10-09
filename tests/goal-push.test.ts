// tests/goal-push.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { pushGoal, getActiveGoals } from '../src/store/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('pushGoal + getActiveGoals', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-push-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('push then list returns the new goal as active', () => {
    const goal = pushGoal(root, {
      sessionId: 's1',
      tenantId: 'default',
      goalName: 'review auth code',
    });
    expect(goal.id).toMatch(/^g_/);
    expect(goal.status).toBe('active');

    const active = getActiveGoals(root, { sessionId: 's1', tenantId: 'default' });
    expect(active).toHaveLength(1);
    expect(active[0].goalName).toBe('review auth code');
  });

  it('isolates goals across sessions and tenants', () => {
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A' });
    pushGoal(root, { sessionId: 's2', tenantId: 'default', goalName: 'B' });
    pushGoal(root, { sessionId: 's1', tenantId: 't2', goalName: 'C' });
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 'default' })[0].goalName).toBe('A');
    expect(getActiveGoals(root, { sessionId: 's2', tenantId: 'default' })[0].goalName).toBe('B');
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 't2' })[0].goalName).toBe('C');
  });

  it('attaches retrieval policy when provided (no FK error)', () => {
    const g = pushGoal(root, {
      sessionId: 's1',
      tenantId: 'default',
      goalName: 'with policy',
      policy: { policyType: 'error-prioritized', errorPriority: 2.0 },
    });
    expect(g.retrievalPolicyId).toBeDefined();
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 'default' })[0].retrievalPolicyId).toBe(g.retrievalPolicyId);
  });
  function goalRowCount(): number {
    const db = openHippoDb(root);
    try {
      return (db.prepare('SELECT COUNT(*) AS c FROM goal_stack').get() as { c: number }).c;
    } finally {
      closeHippoDb(db);
    }
  }

  it('refuses a parent goal id that does not exist and writes no row', () => {
    expect(() => pushGoal(root, {
      sessionId: 's1', tenantId: 'default', goalName: 'child', parentGoalId: 'g_missing',
    })).toThrow(new Error('parent goal not found: g_missing'));
    expect(goalRowCount()).toBe(0);
  });

  it('refuses a parent goal owned by another tenant and writes no new row', () => {
    const parent = pushGoal(root, { sessionId: 's1', tenantId: 't2', goalName: 'parent' });
    expect(() => pushGoal(root, {
      sessionId: 's1', tenantId: 'default', goalName: 'child', parentGoalId: parent.id,
    })).toThrow(new Error(`parent goal ${parent.id} belongs to a different (tenant, session)`));
    expect(goalRowCount()).toBe(1);
  });

  it('refuses a parent goal sitting in another session and writes no new row', () => {
    const parent = pushGoal(root, { sessionId: 's2', tenantId: 'default', goalName: 'parent' });
    expect(() => pushGoal(root, {
      sessionId: 's1', tenantId: 'default', goalName: 'child', parentGoalId: parent.id,
    })).toThrow(new Error(`parent goal ${parent.id} belongs to a different (tenant, session)`));
    expect(goalRowCount()).toBe(1);
  });
});
