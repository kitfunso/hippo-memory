import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';

const savedCwd = process.cwd();
let home = '';

async function hippo(...args: string[]): Promise<string> {
  const res = await runInProcess(() => runCli(['node', 'hippo', ...args]));
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

beforeEach(() => {
  home = makeRoot('audit-cli', { init: false });
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
});

describe('hippo audit list', () => {
  it('lists events after remember + recall', async () => {
    vi.stubEnv('HIPPO_HOME', home);
    await hippo('init');
    await hippo('init', '--global');
    await hippo('remember', 'audit-list-canary distinguishing token', '--global');
    await hippo('recall', 'audit-list-canary');

    const events = JSON.parse(await hippo('audit', 'list', '--json', '--global'));
    const ops = events.map((e: { op: string }) => e.op);
    expect(ops).toContain('remember');
    expect(ops).toContain('recall');
  });
});

describe('hippo audit --fix --dry-run', () => {
  it('reports what it would remove and deletes nothing', async () => {
    vi.stubEnv('HIPPO_HOME', join(home, 'global'));
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    await hippo('init', '--no-hooks', '--no-schedule', '--no-learn');
    await hippo('remember', 'tiny note');
    expect(await hippo('audit', '--fix', '--dry-run')).toContain('Would remove 1 error-severity');
    expect(await hippo('audit')).toContain('tiny note');
  });
});
