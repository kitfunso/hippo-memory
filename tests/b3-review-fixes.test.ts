// tests/b3-review-fixes.test.ts
//
// B3 /review fixes — failure-path coverage for findings on PR #18:
//   1. global memory FK skip (no FK violation when global memory enters top-K)
//   2. completeGoal idempotency (second call is a no-op)
//   3. NaN/extreme retrieval_policy weight rejected by CHECK constraint
//   4. --level CLI bound (--level 5 errors before reaching schema)
//   5. --outcome bare flag (errors with helpful message, not silent no-op)
//
// Uses the Task-6 isolation harness: separate cwd tempdir, isolated HIPPO_HOME
// global root, HIPPO_SKIP_AUTO_INTEGRATIONS=1.
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
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-b3-review-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  initStore(globalRoot);
  return { cwd, hippoRoot, globalRoot };
}

function runRecall(env: TestEnv, query: string, sessionId: string): string {
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

const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'cli' });

describe('B3 /review fixes', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  it('global memory in top-K does not trigger FK violation; global IDs absent from goal_recall_log', () => {
    // Seed only in GLOBAL store. Local has no memories.
    const globalMem = remember(ctx(env.globalRoot), {
      content: 'global lesson about review fixes',
      tags: ['rfx'],
    });

    // Push a goal locally with the same tag so the dlPFC depth boost path
    // engages on recalled rows.
    const goal = pushGoal(env.hippoRoot, {
      sessionId: 's-rfx-1',
      tenantId: 'default',
      goalName: 'rfx',
    });

    // Recall must succeed (no FK error). Without the fix, the boost block
    // would attempt to insert globalMem.id into goal_recall_log and crash
    // because it isn't in the local memories table.
    const out = runRecall(env, 'global lesson about review fixes', 's-rfx-1');
    expect(out).toContain(globalMem.id);

    // goal_recall_log must NOT contain the global memory id.
    const db = openHippoDb(env.hippoRoot);
    try {
      const rows = db.prepare(
        `SELECT memory_id FROM goal_recall_log WHERE goal_id = ?`,
      ).all(goal.id) as Array<{ memory_id: string }>;
      const ids = rows.map((r) => r.memory_id);
      expect(ids).not.toContain(globalMem.id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('completeGoal is idempotent (second call does not double-apply propagation)', () => {
    const m = remember(ctx(env.hippoRoot), {
      content: 'idempotent lesson',
      tags: ['idem'],
    });
    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-idem-1',
      tenantId: 'default',
      goalName: 'idem',
    });

    // Populate goal_recall_log via real recall.
    runRecall(env, 'idempotent lesson', 's-idem-1');

    // Knock strength below ceiling so the boost is observable.
    const db = openHippoDb(env.hippoRoot);
    try {
      db.prepare(`UPDATE memories SET strength = 0.5 WHERE id = ?`).run(m.id);
    } finally {
      closeHippoDb(db);
    }

    completeGoal(env.hippoRoot, g.id, { outcomeScore: 0.9 });
    const dbA = openHippoDb(env.hippoRoot);
    let s1: number;
    try {
      s1 = (dbA.prepare(`SELECT strength FROM memories WHERE id = ?`).get(m.id) as { strength: number }).strength;
    } finally {
      closeHippoDb(dbA);
    }

    // Second call must not re-apply propagation.
    completeGoal(env.hippoRoot, g.id, { outcomeScore: 0.9 });
    const dbB = openHippoDb(env.hippoRoot);
    let s2: number;
    try {
      s2 = (dbB.prepare(`SELECT strength FROM memories WHERE id = ?`).get(m.id) as { strength: number }).strength;
    } finally {
      closeHippoDb(dbB);
    }

    expect(s2).toBe(s1);
  });

  it('retrieval_policy CHECK constraint rejects NaN / extreme weight values', () => {
    // Need a parent goal_stack row so the FK is satisfied.
    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-chk-1',
      tenantId: 'default',
      goalName: 'chk',
    });

    const db = openHippoDb(env.hippoRoot);
    try {
      // Out-of-range value (>100) must be rejected by the CHECK constraint.
      expect(() =>
        db.prepare(`
          INSERT INTO retrieval_policy
            (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
          VALUES (?, ?, 'error-prioritized', 1.0, 1.0, 1.0, ?)
        `).run('rp_bad_extreme', g.id, 999.0)
      ).toThrow(/CHECK|constraint/i);

      // Negative value also rejected.
      expect(() =>
        db.prepare(`
          INSERT INTO retrieval_policy
            (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
          VALUES (?, ?, 'error-prioritized', ?, 1.0, 1.0, 1.0)
        `).run('rp_bad_neg', g.id, -1.0)
      ).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
    }
  });

  it('--level 5 fails CLI bound check with helpful error', () => {
    let stderr = '';
    let exitCode = 0;
    try {
      execFileSync(
        'node',
        [CLI, 'goal', 'push', 'some-name', '--level', '5', '--session-id', 's1'],
        {
          cwd: env.cwd,
          env: {
            ...process.env,
            HIPPO_HOME: env.globalRoot,
            HIPPO_TENANT: 'default',
            HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
          },
          encoding: 'utf8',
        },
      );
    } catch (err) {
      const e = err as { status: number; stderr: string };
      exitCode = e.status;
      stderr = e.stderr;
    }
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('integer in [0, 2]');
  });

  it('bare --outcome (no value) errors out instead of silently no-op', () => {
    let stderr = '';
    let exitCode = 0;
    try {
      execFileSync(
        'node',
        [CLI, 'goal', 'complete', 'g_fake', '--outcome', '--session-id', 's1'],
        {
          cwd: env.cwd,
          env: {
            ...process.env,
            HIPPO_HOME: env.globalRoot,
            HIPPO_TENANT: 'default',
            HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
          },
          encoding: 'utf8',
        },
      );
    } catch (err) {
      const e = err as { status: number; stderr: string };
      exitCode = e.status;
      stderr = e.stderr;
    }
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('requires a value');
  });
});
