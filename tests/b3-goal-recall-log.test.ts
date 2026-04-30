// tests/b3-goal-recall-log.test.ts
//
// B3 Task 8: verify goal_recall_log captures memories recalled via real CLI
// recall under an active goal — and stays empty when no active goal matches.
//
// Uses the Task-6 isolation harness pattern: separate cwd tempdir, isolated
// HIPPO_HOME global root, HIPPO_SKIP_AUTO_INTEGRATIONS=1, initStore on the
// per-test .hippo dir. This prevents dev-machine memories from leaking in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-b3-recall-log-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}

function runRecall(env: TestEnv, query: string, sessionId: string, extraArgs: string[] = []) {
  return execFileSync(
    'node',
    [CLI, 'recall', query, '--json', '--budget', '2000', ...extraArgs],
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

describe('goal_recall_log captured from real CLI recall', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  it('top-K boosted memories land in goal_recall_log with the active goal', () => {
    const m1 = remember(ctx(env.hippoRoot), {
      content: 'lesson on auth refactor',
      tags: ['auth-rewrite'],
    });
    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-log-1',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });

    runRecall(env, 'auth refactor', 's-log-1');

    const db = openHippoDb(env.hippoRoot);
    try {
      const rows = db
        .prepare(`SELECT goal_id, memory_id FROM goal_recall_log WHERE goal_id = ?`)
        .all(g.id) as Array<{ goal_id: string; memory_id: string }>;
      expect(rows.some((r) => r.memory_id === m1.id)).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('no log row is written when no active goal matches', () => {
    remember(ctx(env.hippoRoot), { content: 'unrelated note' });
    pushGoal(env.hippoRoot, {
      sessionId: 's-log-2',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });

    runRecall(env, 'unrelated', 's-log-2');

    const db = openHippoDb(env.hippoRoot);
    try {
      const rows = db
        .prepare(`SELECT COUNT(*) AS c FROM goal_recall_log`)
        .get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});
