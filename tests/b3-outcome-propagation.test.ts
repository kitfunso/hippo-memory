// tests/b3-outcome-propagation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal, completeGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'cli' });

function readStrength(root: string, memId: string): number {
  const db = openHippoDb(root);
  try {
    return (db.prepare(`SELECT strength FROM memories WHERE id = ?`).get(memId) as { strength: number }).strength;
  } finally {
    closeHippoDb(db);
  }
}

function seedRecallLog(root: string, goalId: string, memoryId: string, recalledAt: string) {
  const db = openHippoDb(root);
  try {
    db.prepare(
      `INSERT INTO goal_recall_log (goal_id, memory_id, tenant_id, session_id, recalled_at, score) VALUES (?, ?, 'default', 's1', ?, 1.0)`,
    ).run(goalId, memoryId, recalledAt);
  } finally {
    closeHippoDb(db);
  }
}

function setStrength(root: string, memoryId: string, strength: number) {
  const db = openHippoDb(root);
  try {
    db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`).run(strength, memoryId);
  } finally {
    closeHippoDb(db);
  }
}

describe('completeGoal lifespan-windowed propagation', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-out-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('outcome >= 0.7 boosts memories recalled within the goal lifespan', () => {
    const m = remember(ctx(root), { content: 'lesson', tags: ['rfx'] });
    // Default strength is 1.0 (ceiling); knock it down so the 1.10x boost shows.
    setStrength(root, m.id, 0.5);
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, new Date().toISOString());
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    expect(readStrength(root, m.id)).toBeGreaterThan(before);
  });

  it('outcome < 0.3 decays memories within window', () => {
    const m = remember(ctx(root), { content: 'misleading', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, new Date().toISOString());
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.1 });
    expect(readStrength(root, m.id)).toBeLessThan(before);
  });

  it('neutral band [0.3, 0.7) leaves strength unchanged', () => {
    const m = remember(ctx(root), { content: 'neutral', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, new Date().toISOString());
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.5 });
    expect(readStrength(root, m.id)).toBe(before);
  });

  it('memories recalled BEFORE the goal lifespan are NOT propagated', () => {
    const m = remember(ctx(root), { content: 'pre-goal', tags: ['rfx'] });
    // Seed a log row dated yesterday — before any goal exists.
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, yesterday); // outside lifespan
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    expect(readStrength(root, m.id)).toBe(before); // no change
  });

  it('UNIQUE(memory_id, goal_id) prevents double-propagation if the log is poked twice', () => {
    const m = remember(ctx(root), { content: 'once', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    const now = new Date().toISOString();
    seedRecallLog(root, g.id, m.id, now);
    expect(() => seedRecallLog(root, g.id, m.id, now)).toThrow(/UNIQUE/i);
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    // Strength multiplied by 1.10 once, not twice.
  });

  it('strength clamps at upper bound 1.0', () => {
    const m = remember(ctx(root), { content: 'near-ceiling', tags: ['rfx'] });
    // The remember API doesn't expose strength; override directly.
    setStrength(root, m.id, 0.95);
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, new Date().toISOString());
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    // 0.95 * 1.10 = 1.045, but SQLite's MIN(1.0, MAX(0.0, ...)) clamps at 1.0.
    expect(readStrength(root, m.id)).toBe(1.0);
  });
});
