// tests/b3-goal-types.test.ts
import { describe, it, expect } from 'vitest';
import { rowToGoal, type GoalRow } from '../src/goals.js';

describe('rowToGoal', () => {
  it('maps row → Goal with required fields', () => {
    const row: GoalRow = {
      id: 'g1',
      session_id: 's1',
      tenant_id: 'default',
      goal_name: 'review auth code',
      level: 0,
      parent_goal_id: null,
      status: 'active',
      success_condition: null,
      retrieval_policy_id: null,
      created_at: '2026-04-29T00:00:00.000Z',
      completed_at: null,
      outcome_score: null,
    };
    const goal = rowToGoal(row);
    expect(goal.id).toBe('g1');
    expect(goal.sessionId).toBe('s1');
    expect(goal.tenantId).toBe('default');
    expect(goal.goalName).toBe('review auth code');
    expect(goal.status).toBe('active');
    expect(goal.parentGoalId).toBeUndefined();
    expect(goal.completedAt).toBeUndefined();
  });

  it('preserves completed goals with outcome_score', () => {
    const row: GoalRow = {
      id: 'g2',
      session_id: 's1',
      tenant_id: 'default',
      goal_name: 'done',
      level: 0,
      parent_goal_id: null,
      status: 'completed',
      success_condition: null,
      retrieval_policy_id: null,
      created_at: '2026-04-29T00:00:00.000Z',
      completed_at: '2026-04-29T01:00:00.000Z',
      outcome_score: 0.85,
    };
    const goal = rowToGoal(row);
    expect(goal.status).toBe('completed');
    expect(goal.completedAt).toBe('2026-04-29T01:00:00.000Z');
    expect(goal.outcomeScore).toBe(0.85);
  });
});
