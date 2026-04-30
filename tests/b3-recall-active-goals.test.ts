// tests/b3-recall-active-goals.test.ts
//
// B3 Task 6: dlPFC depth — CLI recall auto-boost from active goal stack.
//
// Verifies the post-hoc boost in src/cli.ts that fires when HIPPO_SESSION_ID
// is set (env or --session-id flag) and the (tenant, session) has active
// goals. Memories whose tags overlap any active goal's name get a score
// multiplier (capped at MAX_FINAL_MULTIPLIER = 3.0x). Each boosted
// (memory, goal) pair is logged into goal_recall_log.
//
// Real DB, real CLI subprocess — no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal, completeGoal } from '../src/goals.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-b3-cli-recall-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}

function recallCli(
  env: TestEnv,
  query: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): { results: Array<{ content: string; score: number }>; raw: string } {
  const raw = execFileSync(
    'node',
    [CLI, 'recall', query, '--json', '--budget', '2000', ...extraArgs],
    {
      cwd: env.cwd,
      env: {
        ...process.env,
        HIPPO_HOME: env.globalRoot,
        HIPPO_TENANT: 'default',
        HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
  const start = raw.indexOf('{');
  const parsed = JSON.parse(raw.slice(start));
  return { results: parsed.results ?? [], raw };
}

describe('cli recall + active goal stack', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    if (env?.cwd) rmSync(env.cwd, { recursive: true, force: true });
  });

  it('without active goals (no HIPPO_SESSION_ID), top-3 unchanged from baseline', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'plan note three for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    const { results } = recallCli(env, 'auth migration');
    const top = results.slice(0, 3).map((r) => r.content);
    expect(top.some((c) => c.includes('plan note'))).toBe(true);
  });

  it('with HIPPO_SESSION_ID set and an active goal whose name matches a tag, tagged memories surface in top-2', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'plan note three for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    pushGoal(env.hippoRoot, { sessionId: 's-cli-1', tenantId: 'default', goalName: 'auth-rewrite' });

    const { results } = recallCli(env, 'auth migration', { HIPPO_SESSION_ID: 's-cli-1' });
    const top = results.slice(0, 2).map((r) => r.content);
    expect(top.some((c) => c.includes('marker tagged A'))).toBe(true);
    expect(top.some((c) => c.includes('marker tagged B'))).toBe(true);
  });

  it('completed goals do not affect ranking (test asserts ORDER, not just length)', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });

    // Baseline (no active goal) ordering, captured BEFORE we push/complete the
    // goal so strength-boost side effects from completeGoal cannot perturb it.
    const baseline = recallCli(env, 'auth migration').results.map((r) => r.content);

    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-cli-1',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });
    completeGoal(env.hippoRoot, g.id, { outcomeScore: 1.0 });

    const withSession = recallCli(env, 'auth migration', {
      HIPPO_SESSION_ID: 's-cli-1',
    }).results.map((r) => r.content);

    // After completion, the active-goal boost should NOT fire. Order must match
    // the pre-completion baseline (active-goal list is empty post-completion).
    expect(withSession).toEqual(baseline);
  });

  it('explicit --goal still works as a manual override (MVP behavior preserved)', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'plan note three for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    const { results } = recallCli(env, 'auth migration', {}, ['--goal', 'auth-rewrite']);
    const top = results.slice(0, 2).map((r) => r.content);
    expect(top.some((c) => c.includes('marker tagged'))).toBe(true);
  });

  // PLAN-ENG-REVIEW INLINE FIX #3: explicit --goal must beat the active goal stack.
  // Active goal `auth-rewrite` on session, but CLI passes --goal other-tag. Top
  // results should contain other-tag-tagged memories, NOT auth-rewrite ones.
  it('explicit --goal flag overrides the active goal stack (MVP wins)', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note alpha untagged content one' });
    remember(ctx, { content: 'plan note beta untagged content two' });
    remember(ctx, { content: 'plan note gamma untagged content three' });
    remember(ctx, { content: 'AAA marker auth-rewrite tagged one', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'BBB marker auth-rewrite tagged two', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'CCC marker other-tag tagged one', tags: ['other-tag'] });
    remember(ctx, { content: 'DDD marker other-tag tagged two', tags: ['other-tag'] });

    pushGoal(env.hippoRoot, {
      sessionId: 's-cli-override',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });

    const { results } = recallCli(
      env,
      'marker tagged',
      { HIPPO_SESSION_ID: 's-cli-override' },
      ['--goal', 'other-tag'],
    );
    const top = results.slice(0, 2).map((r) => r.content);
    // The explicit --goal `other-tag` wins. Top entries should contain
    // other-tag markers, not auth-rewrite markers.
    expect(top.some((c) => c.includes('other-tag'))).toBe(true);
    expect(top.every((c) => !c.includes('auth-rewrite'))).toBe(true);
  });

  // PLAN-ENG-REVIEW INLINE FIX #4: empty active-goal-list must be a clean no-op.
  // HIPPO_SESSION_ID is set but the (tenant, session) has zero active goals.
  // Recall must succeed and produce the same baseline ordering as the no-session case.
  it('empty active-goal list is a no-op (no errors, baseline ranking)', () => {
    const ctx = { hippoRoot: env.hippoRoot, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'plan note three for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    // Push then complete — leaves the (tenant, session) with zero active goals.
    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-empty',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });
    completeGoal(env.hippoRoot, g.id, { outcomeScore: 1.0 });

    const baseline = recallCli(env, 'auth migration').results.map((r) => r.content);
    const withEmpty = recallCli(env, 'auth migration', {
      HIPPO_SESSION_ID: 's-empty',
    }).results.map((r) => r.content);

    // Same ordering: empty active-goal list must not perturb ranking.
    expect(withEmpty).toEqual(baseline);
  });
});
