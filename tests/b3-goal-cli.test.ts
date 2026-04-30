// tests/b3-goal-cli.test.ts
//
// B3 Task 10: real CLI subprocess tests for `hippo goal push/list/complete/
// suspend/resume`. Uses the Task-6 isolation harness (separate cwd tempdir +
// isolated HIPPO_HOME global root + HIPPO_SKIP_AUTO_INTEGRATIONS=1) so dev
// memories don't leak in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

function makeEnv(): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-b3-goalcli-'));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  return { cwd, hippoRoot, globalRoot };
}

function run(env: TestEnv, args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    cwd: env.cwd,
    env: {
      ...process.env,
      HIPPO_HOME: env.globalRoot,
      HIPPO_TENANT: 'default',
      HIPPO_SESSION_ID: 's-cli-1',
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    },
    encoding: 'utf8',
  });
}

describe('hippo goal CLI', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    rmSync(env.cwd, { recursive: true, force: true });
  });

  it('push then list shows the active goal', () => {
    const push = run(env, ['goal', 'push', 'review-auth', '--policy', 'error-prioritized']);
    expect(push).toMatch(/^g_[a-f0-9]+/);
    const list = run(env, ['goal', 'list']);
    expect(list).toContain('review-auth');
    expect(list).toContain('active');
  });

  it('complete --outcome closes the goal', () => {
    const id = run(env, ['goal', 'push', 'task-x']).match(/g_[a-f0-9]+/)![0];
    run(env, ['goal', 'complete', id, '--outcome', '0.9']);
    const list = run(env, ['goal', 'list', '--all']);
    expect(list).toContain('completed');
    expect(list).toContain('0.9');
  });

  it('suspend then resume cycles status', () => {
    const id = run(env, ['goal', 'push', 'pause-test']).match(/g_[a-f0-9]+/)![0];
    run(env, ['goal', 'suspend', id]);
    expect(run(env, ['goal', 'list'])).not.toContain('pause-test');
    run(env, ['goal', 'resume', id]);
    expect(run(env, ['goal', 'list'])).toContain('pause-test');
  });
});
