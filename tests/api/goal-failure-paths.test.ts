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

async function runRecall(query: string, sessionId: string): Promise<string> {
  vi.stubEnv('HIPPO_SESSION_ID', sessionId);
  const res = await runInProcess(() => runCli(['node', 'hippo', 'recall', query, '--json', '--budget', '2000']));
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

const ctx = (root: string): FullContext => apiCtx(root, 'default', { subject: 'cli', role: 'admin' });

describe('goal recall log and retrieval policy failure paths', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv('b3-review', { initGlobal: true });
    vi.stubEnv('HIPPO_HOME', env.globalRoot);
    vi.stubEnv('HIPPO_TENANT', 'default');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    process.chdir(env.cwd);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    rmSync(env.cwd, { recursive: true, force: true });
  });

  it('global memory in top-K does not trigger FK violation; global IDs absent from goal_recall_log', async () => {
    const globalMem = await remember(ctx(env.globalRoot), {
      content: 'global lesson about review fixes',
      tags: ['rfx'],
    });

    const goal = await pushGoal(env.hippoRoot, {
      sessionId: 's-rfx-1',
      tenantId: 'default',
      goalName: 'rfx',
    });

    const out = await runRecall('global lesson about review fixes', 's-rfx-1');
    expect(out).toContain(globalMem.id);

    const db = openHippoDb(env.hippoRoot);
    try {
      // SAFETY: goal_recall_log's memory_id column is a NOT NULL TEXT FK;
      // .all() rows always match the queried SELECT's single column.
      const rows = db.prepare(`SELECT memory_id FROM goal_recall_log WHERE goal_id = ?`).all(goal.id) as Array<{
        memory_id: string;
      }>;
      const ids = rows.map((r) => r.memory_id);
      expect(ids).not.toContain(globalMem.id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('retrieval_policy CHECK constraint rejects NaN / extreme weight values', async () => {
    const g = await pushGoal(env.hippoRoot, {
      sessionId: 's-chk-1',
      tenantId: 'default',
      goalName: 'chk',
    });

    const db = openHippoDb(env.hippoRoot);
    try {
      expect(() =>
        db
          .prepare(`
          INSERT INTO retrieval_policy
            (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
          VALUES (?, ?, 'error-prioritized', 1.0, 1.0, 1.0, ?)
        `)
          .run('rp_bad_extreme', g.id, 999.0),
      ).toThrow(/CHECK|constraint/i);

      expect(() =>
        db
          .prepare(`
          INSERT INTO retrieval_policy
            (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
          VALUES (?, ?, 'error-prioritized', ?, 1.0, 1.0, 1.0)
        `)
          .run('rp_bad_neg', g.id, -1.0),
      ).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
    }
  });
});
