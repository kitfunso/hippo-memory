// tests/b3-retrieval-policy.test.ts
//
// B3 Task 7: dlPFC depth — retrieval policy weighting with hard-capped final
// multiplier. Verifies the policy-aware extension to the active-goal boost
// block in src/cli.ts:
//   - error-prioritized policy ranks error-tagged > non-error within a goal.
//   - composed multiplier is hard-capped at MAX_FINAL_MULTIPLIER (3.0x), even
//     with an extreme errorPriority (e.g. 9.0).
//
// Real DB, real CLI subprocess. Same isolation harness as Task 6
// (cwd tempdir, separate HIPPO_HOME global root, HIPPO_SKIP_AUTO_INTEGRATIONS=1)
// to keep dev-machine memories from leaking into tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal } from '../src/goals.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-b3-pol-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}

function recallCli(
  env: TestEnv,
  query: string,
  sessionId: string,
): Array<{ content: string; score: number }> {
  const raw = execFileSync(
    'node',
    [CLI, 'recall', query, '--json', '--budget', '4000'],
    {
      cwd: env.cwd,
      env: {
        ...process.env,
        HIPPO_HOME: env.globalRoot,
        HIPPO_TENANT: 'default',
        HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
        ...(sessionId ? { HIPPO_SESSION_ID: sessionId } : {}),
      },
      encoding: 'utf8',
    },
  );
  const start = raw.indexOf('{');
  const parsed = JSON.parse(raw.slice(start));
  return parsed.results ?? [];
}

describe('retrieval policy', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  it('error-prioritized policy ranks error-tagged > non-error within same goal', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'note one about auth refactor', tags: ['auth-rewrite'] });
    remember(ctx, {
      content: 'lesson learned during auth refactor: bare except handler caused a bug',
      tags: ['auth-rewrite', 'error'],
    });
    remember(ctx, { content: 'note two about auth refactor', tags: ['auth-rewrite'] });

    pushGoal(env.hippoRoot, {
      sessionId: 's-p1',
      tenantId: 'default',
      goalName: 'auth-rewrite',
      policy: { policyType: 'error-prioritized', errorPriority: 3.0 },
    });

    const top = recallCli(env, 'auth refactor', 's-p1');
    expect(top[0].content).toContain('lesson learned');
  });

  it('final multiplier never exceeds 3.0x even with extreme policy weights', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'high-error lesson', tags: ['plan-x', 'error'] });

    // Baseline: no session → no boost.
    const base = recallCli(env, 'high-error lesson', '');
    const baseScore = base[0]?.score ?? 1.0;

    pushGoal(env.hippoRoot, {
      sessionId: 's-p2',
      tenantId: 'default',
      goalName: 'plan-x',
      policy: { policyType: 'error-prioritized', errorPriority: 9.0 },
    });
    const boosted = recallCli(env, 'high-error lesson', 's-p2');
    const boostedScore = boosted[0]?.score ?? 0;

    // Allow tiny floating-point slop above 3.0x base.
    expect(boostedScore / baseScore).toBeLessThanOrEqual(3.01);
    // And the boost did fire (proves the cap isn't masking a no-op).
    expect(boostedScore / baseScore).toBeGreaterThan(1.5);
  });
});
