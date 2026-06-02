/**
 * A7 recall-trace — goals.ts parity.
 *
 * `applyGoalStackBoost` with vs without the optional `opts.trace` accumulator
 * must produce byte-identical ordered output AND identical scores. The trace
 * is a pure side-channel; passing the Map must not perturb the score-multiply
 * or the re-sort. Real SQLite store, no mocks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { applyGoalStackBoost, pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import type { MemoryEntry } from '../src/memory.js';
import type { RerankStep } from '../src/search.js';

describe('A7 applyGoalStackBoost trace parity (side-channel)', () => {
  let hippoRoot: string;
  const tenantId = 'default';
  const sessionId = 'sess-a7-parity';

  beforeEach(async () => {
    hippoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hippo-a7-parity-'));
    initStore(hippoRoot);
  });

  function seed(content: string, tags: string[]): MemoryEntry {
    const entry = createMemory(content, { tags, tenantId });
    writeEntry(hippoRoot, entry);
    return entry;
  }

  it('produces identical ordered output + scores with vs without the trace accumulator', () => {
    const goalMatch = seed('auth bug fix details', ['fix-auth']);
    const unrelated = seed('auth UI polish', ['ui']);
    pushGoal(hippoRoot, { sessionId, tenantId, goalName: 'fix-auth' });

    const rows = [
      { entry: goalMatch, score: 0.9 },
      { entry: unrelated, score: 0.8 },
    ];

    // Without the accumulator (default path).
    const db1 = openHippoDb(hippoRoot);
    let without;
    try {
      without = applyGoalStackBoost(db1, rows.map((r) => ({ ...r })), {
        sessionId,
        tenantId,
        limit: 10,
      });
    } finally {
      closeHippoDb(db1);
    }

    // With the accumulator (side-channel populated).
    const trace = new Map<string, RerankStep>();
    const db2 = openHippoDb(hippoRoot);
    let withTrace;
    try {
      withTrace = applyGoalStackBoost(db2, rows.map((r) => ({ ...r })), {
        sessionId,
        tenantId,
        limit: 10,
        trace,
      });
    } finally {
      closeHippoDb(db2);
    }

    // Identical ordered ids and identical scores.
    expect(withTrace.map((r) => r.entry.id)).toEqual(without.map((r) => r.entry.id));
    expect(withTrace.map((r) => r.score)).toEqual(without.map((r) => r.score));

    // The accumulator captured the goal-boost step for the boosted row only,
    // and its scoreBefore/scoreAfter agree with the actual mutation.
    const step = trace.get(goalMatch.id);
    expect(step).toBeDefined();
    expect(step!.stage).toBe('goal-boost');
    expect(step!.scoreBefore).toBe(0.9);
    expect(step!.scoreAfter).toBe(0.9 * step!.multiplier!);
    // The unrelated (non-matching) row got no step.
    expect(trace.get(unrelated.id)).toBeUndefined();
  });
});
