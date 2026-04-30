// tests/b3-outcome-end-to-end.test.ts
//
// B3 Task 9: end-to-end outcome propagation through real CLI recall.
// Verifies the full loop: real CLI recall -> goal_recall_log populated ->
// completeGoal propagates onto memories.strength.
//
// Uses Task-6 isolation harness (separate cwd tempdir + isolated HIPPO_HOME
// global root + HIPPO_SKIP_AUTO_INTEGRATIONS=1) to keep dev memories out.
//
// Strength-clamp note (mirrors Task 5's pattern): remember() creates rows at
// strength 1.0 (the ceiling). The positive-outcome boost (1.10x) clamps back
// to 1.0, hiding the lift. Knock the seed down to 0.5 with a direct UPDATE
// before reading `before` so the boost is observable. The decay test starts
// from 1.0 and goes to 0.85 — observable as-is.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal, completeGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-b3-e2e-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}

function runRecall(env: TestEnv, query: string, sessionId: string) {
  return execFileSync(
    'node',
    [CLI, 'recall', query, '--json', '--budget', '2000'],
    {
      cwd: env.cwd,
      env: {
        ...process.env,
        HIPPO_HOME: env.globalRoot,
        HIPPO_TENANT: 'default',
        HIPPO_SESSION_ID: sessionId,
        HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
      },
      encoding: 'utf8',
    },
  );
}

function readStrength(root: string, memId: string): number {
  const db = openHippoDb(root);
  try {
    return (db.prepare(`SELECT strength FROM memories WHERE id = ?`).get(memId) as {
      strength: number;
    }).strength;
  } finally {
    closeHippoDb(db);
  }
}

function setStrength(root: string, memId: string, strength: number) {
  const db = openHippoDb(root);
  try {
    db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`).run(strength, memId);
  } finally {
    closeHippoDb(db);
  }
}

const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'cli' });

describe('outcome propagation E2E (recall -> log -> completeGoal)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  it('positive outcome boosts strength of memories actually recalled during goal life', () => {
    const m = remember(ctx(env.hippoRoot), { content: 'good lesson', tags: ['rfx'] });
    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-e2e-1',
      tenantId: 'default',
      goalName: 'rfx',
    });

    runRecall(env, 'good lesson', 's-e2e-1');

    // Knock strength below the 1.0 ceiling AFTER recall so the 1.10x boost
    // from completeGoal is observable. Recall itself touches strength, so
    // setting it before the recall would be a no-op.
    setStrength(env.hippoRoot, m.id, 0.5);

    const before = readStrength(env.hippoRoot, m.id);
    completeGoal(env.hippoRoot, g.id, { outcomeScore: 0.9 });
    expect(readStrength(env.hippoRoot, m.id)).toBeGreaterThan(before);
  });

  it('negative outcome decays strength', () => {
    const m = remember(ctx(env.hippoRoot), { content: 'misleading lesson', tags: ['rfx'] });
    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-e2e-2',
      tenantId: 'default',
      goalName: 'rfx',
    });

    runRecall(env, 'misleading lesson', 's-e2e-2');

    const before = readStrength(env.hippoRoot, m.id);
    completeGoal(env.hippoRoot, g.id, { outcomeScore: 0.1 });
    expect(readStrength(env.hippoRoot, m.id)).toBeLessThan(before);
  });
});
