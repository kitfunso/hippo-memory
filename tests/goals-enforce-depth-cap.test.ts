/**
 * v1.7.4 — the depth cap shared by pushGoal and resumeGoal, pinned through both public entry points.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initStore } from '../src/store/open.js';
import { getActiveGoals, getSessionGoals, pushGoal, resumeGoal, suspendGoal } from '../src/store/goals.js';

describe('depth cap shared by pushGoal and resumeGoal', () => {
  let hippoRoot: string;
  const tenantId = 'default';
  const sessionId = 'sess-cap';
  const opts = { sessionId, tenantId };

  beforeEach(async () => {
    hippoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hippo-1.7.4-'));
    initStore(hippoRoot);
  });

  it('suspends nothing when the active goal count is below the cap', () => {
    pushGoal(hippoRoot, { ...opts, goalName: 'g1' });
    pushGoal(hippoRoot, { ...opts, goalName: 'g2' });
    expect(getActiveGoals(hippoRoot, opts)).toHaveLength(2);
    expect(getSessionGoals(hippoRoot, opts).filter((g) => g.status === 'suspended')).toHaveLength(0);
  });

  it('suspends the oldest active goal when a resume would pass the cap', () => {
    const goals = ['g0', 'g1', 'g2'].map((goalName) => pushGoal(hippoRoot, { ...opts, goalName }));
    suspendGoal(hippoRoot, goals[2]!.id);
    pushGoal(hippoRoot, { ...opts, goalName: 'g3' });
    expect(getActiveGoals(hippoRoot, opts)).toHaveLength(3);

    resumeGoal(hippoRoot, goals[2]!.id);
    const active = getActiveGoals(hippoRoot, opts).map((g) => g.goalName);
    expect(active).toHaveLength(3);
    expect(active).not.toContain('g0');
    expect(active).toContain('g2');
  });
});
