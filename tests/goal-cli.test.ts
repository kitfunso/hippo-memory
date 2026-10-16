// `hippo goal push|list|complete|suspend|resume` and its flag errors, run in process through runCli on a real
// store with an isolated HIPPO_HOME, so dev memories don't leak in.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { runCli } from '../src/cli.js';
import { makeEnv, type TestEnv } from './_helpers/cli-env.js';
import { runInProcess, type InProcessResult } from './_helpers/run-in-process.js';

const savedCwd = process.cwd();
let env: TestEnv;

beforeEach(() => {
  env = makeEnv('b3-goalcli');
  vi.stubEnv('HIPPO_HOME', env.globalRoot);
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SESSION_ID', 's-cli-1');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  // The CLI looks for the store in `.hippo` under the working directory.
  process.chdir(env.cwd);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(env.cwd, { recursive: true, force: true });
});

const goal = (...args: string[]): Promise<InProcessResult> => runInProcess(() => runCli(['node', 'hippo', 'goal', ...args]));

/** Stdout of a goal verb that must succeed. */
async function ok(...args: string[]): Promise<string> {
  const res = await goal(...args);
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

function goalId(output: string): string {
  const id = /g_[a-f0-9]+/.exec(output)?.[0];
  if (id === undefined) throw new Error(`no goal id in CLI output: ${output}`);
  return id;
}

describe('hippo goal CLI', () => {
  it('push then list shows the active goal', async () => {
    expect(await ok('push', 'review-auth', '--policy', 'error-prioritized')).toMatch(/^g_[a-f0-9]+/);
    const list = await ok('list');
    expect(list).toContain('review-auth');
    expect(list).toContain('active');
  });

  it('complete --outcome closes the goal', async () => {
    const id = goalId(await ok('push', 'task-x'));
    await ok('complete', id, '--outcome', '0.9');
    const list = await ok('list', '--all');
    expect(list).toContain('completed');
    expect(list).toContain('0.9');
  });

  it('suspend then resume cycles status', async () => {
    const id = goalId(await ok('push', 'pause-test'));
    await ok('suspend', id);
    expect(await ok('list')).not.toContain('pause-test');
    await ok('resume', id);
    expect(await ok('list')).toContain('pause-test');
  });

  it('--level 5 fails CLI bound check with helpful error', async () => {
    const res = await goal('push', 'some-name', '--level', '5', '--session-id', 's1');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('integer in [0, 2]');
  });

  it('bare --outcome (no value) errors out instead of silently no-op', async () => {
    const res = await goal('complete', 'g_fake', '--outcome', '--session-id', 's1');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('requires a value');
  });
});
