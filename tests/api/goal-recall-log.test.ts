// B3 Task 8: goal_recall_log captures memories CLI recall boosts under an active goal, and stays empty when no
// active goal matches. Recall runs in process on a per-test store with an isolated HIPPO_HOME.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { remember } from '../../src/api/index.js';
import { runCli } from '../../src/cli.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeEnv, type TestEnv } from '../_helpers/cli-env.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { pushGoal } from '../_helpers/root-forms.js';

const savedCwd = process.cwd();

/** `hippo recall <query> --json` in this process, with the empty recall rings a fresh `hippo` starts with. */
async function runRecall(query: string, sessionId: string): Promise<void> {
  vi.stubEnv('HIPPO_SESSION_ID', sessionId);
  const res = await runInProcess(() => runCli(['node', 'hippo', 'recall', query, '--json', '--budget', '2000']));
  expect(res.status, res.stderr).toBe(0);
}

const ctx = (root: string): FullContext => apiCtx(root, 'default', { subject: 'cli', role: 'admin' });

describe('goal_recall_log captured from CLI recall', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv('b3-recall-log');
    vi.stubEnv('HIPPO_HOME', env.globalRoot);
    vi.stubEnv('HIPPO_TENANT', 'default');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    // The CLI looks for the store in `.hippo` under the working directory.
    process.chdir(env.cwd);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    rmSync(env.cwd, { recursive: true, force: true });
  });

  it('top-K boosted memories land in goal_recall_log with the active goal', async () => {
    const m1 = await remember(ctx(env.hippoRoot), {
      content: 'lesson on auth refactor',
      tags: ['auth-rewrite'],
    });
    const g = await pushGoal(env.hippoRoot, {
      sessionId: 's-log-1',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });

    await runRecall('auth refactor', 's-log-1');

    const db = openHippoDb(env.hippoRoot);
    try {
      // SAFETY: the db driver's .all() returns `unknown[]`; the row shape is guaranteed
      // by the `SELECT goal_id, memory_id` projection above.
      const rows = db.prepare(`SELECT goal_id, memory_id FROM goal_recall_log WHERE goal_id = ?`).all(g.id) as Array<{
        goal_id: string;
        memory_id: string;
      }>;
      expect(rows.some((r) => r.memory_id === m1.id)).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('no log row is written when no active goal matches', async () => {
    await remember(ctx(env.hippoRoot), { content: 'unrelated note' });
    await pushGoal(env.hippoRoot, {
      sessionId: 's-log-2',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });

    await runRecall('unrelated', 's-log-2');

    const db = openHippoDb(env.hippoRoot);
    try {
      // SAFETY: the db driver's .get() returns `unknown`; `SELECT COUNT(*) AS c` always
      // yields exactly one row with a numeric `c` column.
      const rows = db.prepare(`SELECT COUNT(*) AS c FROM goal_recall_log`).get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});
