// B3 Task 6: CLI recall, run in process, boosts memories whose tags match an active goal of the (tenant, session)
// in HIPPO_SESSION_ID or --session-id, capped at MAX_FINAL_MULTIPLIER (3.0x); an explicit --goal wins over the stack.
import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { remember } from '../src/api/index.js';
import { resetSessionRings } from '../src/api/recall/finish.js';
import { runCli } from '../src/cli.js';
import { makeEnv, type TestEnv } from './_helpers/cli-env.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { pushGoal, completeGoal } from './_helpers/root-forms.js';

const savedCwd = process.cwd();

interface RecallCliResult {
  results: Array<{ content: string; score: number }>;
  raw: string;
}

/** `hippo recall <query> --json` in this process, with the empty recall rings a fresh `hippo` starts with. */
async function recallCli(
  query: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<RecallCliResult> {
  vi.stubEnv('HIPPO_SESSION_ID', '');
  for (const [key, value] of Object.entries(extraEnv)) vi.stubEnv(key, value);
  resetSessionRings('cli');
  const res = await runInProcess(() => runCli(['node', 'hippo', 'recall', query, '--json', '--budget', '2000', ...extraArgs]));
  expect(res.status, res.stderr).toBe(0);
  const raw = res.stdout;
  const start = raw.indexOf('{');
  const parsed = JSON.parse(raw.slice(start));
  return { results: parsed.results ?? [], raw };
}

describe('cli recall + active goal stack', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv('b3-cli-recall');
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

  it('without active goals (no HIPPO_SESSION_ID), top-3 unchanged from baseline', async () => {
    const ctx: FullContext = apiCtx(env.hippoRoot, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'plan note one for the auth migration' });
    await remember(ctx, { content: 'plan note two for the auth migration' });
    await remember(ctx, { content: 'plan note three for the auth migration' });
    await remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    await remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    const { results } = await recallCli('auth migration');
    const top = results.slice(0, 3).map((r) => r.content);
    expect(top.some((c) => c.includes('plan note'))).toBe(true);
  });

  it('with HIPPO_SESSION_ID set and an active goal whose name matches a tag, tagged memories surface in top-2', async () => {
    const ctx: FullContext = apiCtx(env.hippoRoot, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'plan note one for the auth migration' });
    await remember(ctx, { content: 'plan note two for the auth migration' });
    await remember(ctx, { content: 'plan note three for the auth migration' });
    await remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    await remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    pushGoal(env.hippoRoot, { sessionId: 's-cli-1', tenantId: 'default', goalName: 'auth-rewrite' });

    const { results } = await recallCli('auth migration', { HIPPO_SESSION_ID: 's-cli-1' });
    const top = results.slice(0, 2).map((r) => r.content);
    expect(top.some((c) => c.includes('marker tagged A'))).toBe(true);
    expect(top.some((c) => c.includes('marker tagged B'))).toBe(true);
  });

  it('explicit --goal still works as a manual override (MVP behavior preserved)', async () => {
    const ctx: FullContext = apiCtx(env.hippoRoot, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'plan note one for the auth migration' });
    await remember(ctx, { content: 'plan note two for the auth migration' });
    await remember(ctx, { content: 'plan note three for the auth migration' });
    await remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    await remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    const { results } = await recallCli('auth migration', {}, ['--goal', 'auth-rewrite']);
    const top = results.slice(0, 2).map((r) => r.content);
    expect(top.some((c) => c.includes('marker tagged'))).toBe(true);
  });

  // PLAN-ENG-REVIEW INLINE FIX #3: explicit --goal must beat the active goal stack.
  // Active goal `auth-rewrite` on session, but CLI passes --goal other-tag. Top
  // results should contain other-tag-tagged memories, NOT auth-rewrite ones.
  it('explicit --goal flag overrides the active goal stack (MVP wins)', async () => {
    const ctx: FullContext = apiCtx(env.hippoRoot, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'plan note alpha untagged content one' });
    await remember(ctx, { content: 'plan note beta untagged content two' });
    await remember(ctx, { content: 'plan note gamma untagged content three' });
    await remember(ctx, { content: 'AAA marker auth-rewrite tagged one', tags: ['auth-rewrite'] });
    await remember(ctx, { content: 'BBB marker auth-rewrite tagged two', tags: ['auth-rewrite'] });
    await remember(ctx, { content: 'CCC marker other-tag tagged one', tags: ['other-tag'] });
    await remember(ctx, { content: 'DDD marker other-tag tagged two', tags: ['other-tag'] });

    pushGoal(env.hippoRoot, {
      sessionId: 's-cli-override',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });

    const { results } = await recallCli('marker tagged', { HIPPO_SESSION_ID: 's-cli-override' }, ['--goal', 'other-tag']);
    const top = results.slice(0, 2).map((r) => r.content);
    // The explicit --goal `other-tag` wins. Top entries should contain
    // other-tag markers, not auth-rewrite markers.
    expect(top.some((c) => c.includes('other-tag'))).toBe(true);
    expect(top.every((c) => !c.includes('auth-rewrite'))).toBe(true);
  });

  // PLAN-ENG-REVIEW INLINE FIX #4: empty active-goal-list must be a clean no-op.
  // HIPPO_SESSION_ID is set but the (tenant, session) has zero active goals.
  // Recall must succeed and produce the same baseline ordering as the no-session case.
  it('empty active-goal list is a no-op (no errors, baseline ranking)', async () => {
    const ctx: FullContext = apiCtx(env.hippoRoot, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'plan note one for the auth migration' });
    await remember(ctx, { content: 'plan note two for the auth migration' });
    await remember(ctx, { content: 'plan note three for the auth migration' });
    await remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    await remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    // Push then complete — leaves the (tenant, session) with zero active goals.
    const g = pushGoal(env.hippoRoot, {
      sessionId: 's-empty',
      tenantId: 'default',
      goalName: 'auth-rewrite',
    });
    completeGoal(env.hippoRoot, g.id, { outcomeScore: 1.0 });

    const baseline = (await recallCli('auth migration')).results.map((r) => r.content);
    const withEmpty = (await recallCli('auth migration', { HIPPO_SESSION_ID: 's-empty' })).results.map((r) => r.content);

    // Same ordering: empty active-goal list must not perturb ranking.
    expect(withEmpty).toEqual(baseline);
  });
});
