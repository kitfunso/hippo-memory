// B3 Task 9: the full loop, CLI recall in process -> goal_recall_log -> completeGoal moves memories.strength once.
// remember() writes strength 1.0, the ceiling the 1.10x boost clamps to, so the positive case knocks the seed to 0.5
// after the recall; the decay case starts from 1.0 and is visible as-is.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { remember } from '../../src/api/index.js';
import { runCli } from '../../src/cli.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeEnv, type TestEnv } from '../_helpers/cli-env.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { pushGoal, completeGoal } from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const savedCwd = process.cwd();

/** `hippo recall <query> --json` in this process, with the empty recall rings a fresh `hippo` starts with. */
async function runRecall(query: string, sessionId: string): Promise<void> {
  vi.stubEnv('HIPPO_SESSION_ID', sessionId);
  const res = await runInProcess(() => runCli(['node', 'hippo', 'recall', query, '--json', '--budget', '2000']));
  expect(res.status, res.stderr).toBe(0);
}

function readStrength(root: string, memId: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: memId is always a row this test wrote earlier, so the SELECT
    // by primary key always returns exactly one row with a strength column.
    return (
      db.prepare(`SELECT strength FROM memories WHERE id = ?`).get(memId) as {
        strength: number;
      }
    ).strength;
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

const ctx = (root: string): FullContext => apiCtx(root, 'default', { subject: 'cli', role: 'admin' });

describe('outcome propagation E2E (recall -> log -> completeGoal)', () => {
  let env: TestEnv;

  beforeEach(() => {
    // An initialised global store, as the idempotency case had before it merged here, so a recall also finishes on a
    // store that holds none of its results.
    env = makeEnv('b3-e2e', { initGlobal: true });
    vi.stubEnv('HIPPO_HOME', env.globalRoot);
    vi.stubEnv('HIPPO_TENANT', 'default');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    // The CLI looks for the store in `.hippo` under the working directory.
    process.chdir(env.cwd);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    removeAfterRequest(env.cwd);
  });

  it('positive outcome boosts strength of memories actually recalled during goal life, and only once', async () => {
    const m = await remember(ctx(env.hippoRoot), { content: 'good lesson', tags: ['rfx'] });
    const g = await pushGoal(env.hippoRoot, {
      sessionId: 's-e2e-1',
      tenantId: 'default',
      goalName: 'rfx',
    });

    await runRecall('good lesson', 's-e2e-1');

    // Recall itself touches strength, so the knock-down below the ceiling has to come after it.
    setStrength(env.hippoRoot, m.id, 0.5);

    const before = readStrength(env.hippoRoot, m.id);
    await completeGoal(env.hippoRoot, g.id, { outcomeScore: 0.9 });
    const boosted = readStrength(env.hippoRoot, m.id);
    expect(boosted).toBeGreaterThan(before);

    // A second completeGoal must not re-apply propagation.
    await completeGoal(env.hippoRoot, g.id, { outcomeScore: 0.9 });
    expect(readStrength(env.hippoRoot, m.id)).toBe(boosted);
  });

  it('negative outcome decays strength', async () => {
    const m = await remember(ctx(env.hippoRoot), { content: 'misleading lesson', tags: ['rfx'] });
    const g = await pushGoal(env.hippoRoot, {
      sessionId: 's-e2e-2',
      tenantId: 'default',
      goalName: 'rfx',
    });

    await runRecall('misleading lesson', 's-e2e-2');

    const before = readStrength(env.hippoRoot, m.id);
    await completeGoal(env.hippoRoot, g.id, { outcomeScore: 0.1 });
    expect(readStrength(env.hippoRoot, m.id)).toBeLessThan(before);
  });
});
