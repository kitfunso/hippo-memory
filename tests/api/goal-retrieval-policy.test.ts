// B3 Task 7: CLI recall, run in process, weights an active goal's retrieval policy: error-prioritized ranks
// error-tagged rows first, and the composed multiplier stays under MAX_FINAL_MULTIPLIER (3.0x) at errorPriority 9.0.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { remember } from '../../src/api/index.js';
import { resetSessionRings } from '../../src/api/recall/finish.js';
import { runCli } from '../../src/cli.js';
import { pushGoal } from '../../src/store/goals.js';
import { makeEnv, type TestEnv } from '../_helpers/cli-env.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { runInProcess } from '../_helpers/run-in-process.js';

const savedCwd = process.cwd();

/** `hippo recall <query> --json` in this process under `sessionId` ('' for none), with the empty recall rings a fresh `hippo` starts with. */
async function recallCli(query: string, sessionId: string): Promise<Array<{ content: string; score: number }>> {
  vi.stubEnv('HIPPO_SESSION_ID', sessionId);
  resetSessionRings('cli');
  const res = await runInProcess(() => runCli(['node', 'hippo', 'recall', query, '--json', '--budget', '4000']));
  expect(res.status, res.stderr).toBe(0);
  const parsed = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  return parsed.results ?? [];
}

describe('retrieval policy', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv('b3-pol');
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

  it('error-prioritized policy ranks error-tagged > non-error within same goal', async () => {
    const ctx: FullContext = apiCtx(env.hippoRoot, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'note one about auth refactor', tags: ['auth-rewrite'] });
    await remember(ctx, {
      content: 'lesson learned during auth refactor: bare except handler caused a bug',
      tags: ['auth-rewrite', 'error'],
    });
    await remember(ctx, { content: 'note two about auth refactor', tags: ['auth-rewrite'] });

    pushGoal(env.hippoRoot, {
      sessionId: 's-p1',
      tenantId: 'default',
      goalName: 'auth-rewrite',
      policy: { policyType: 'error-prioritized', errorPriority: 3.0 },
    });

    const top = await recallCli('auth refactor', 's-p1');
    expect(top[0].content).toContain('lesson learned');
  });

  it('final multiplier never exceeds 3.0x even with extreme policy weights', async () => {
    const ctx: FullContext = apiCtx(env.hippoRoot, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'high-error lesson', tags: ['plan-x', 'error'] });

    // Baseline: no session → no boost.
    const base = await recallCli('high-error lesson', '');
    const baseScore = base[0]?.score ?? 1.0;

    pushGoal(env.hippoRoot, {
      sessionId: 's-p2',
      tenantId: 'default',
      goalName: 'plan-x',
      policy: { policyType: 'error-prioritized', errorPriority: 9.0 },
    });
    const boosted = await recallCli('high-error lesson', 's-p2');
    const boostedScore = boosted[0]?.score ?? 0;

    // Allow tiny floating-point slop above 3.0x base.
    expect(boostedScore / baseScore).toBeLessThanOrEqual(3.01);
    // And the boost did fire (proves the cap isn't masking a no-op).
    expect(boostedScore / baseScore).toBeGreaterThan(1.5);
  });
});
