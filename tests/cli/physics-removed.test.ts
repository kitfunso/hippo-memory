// 3.0 removed the physics engine: its flags and --classic fail by name, and a physics config block is ignored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli as runCliEntry } from '../../src/cli.js';
import { loadConfig } from '../../src/host/config-file.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';

const savedCwd = process.cwd();
let home = '';
let root = '';

const hippoRun = (...args: string[]): Promise<InProcessResult> =>
  runInProcess(() => runCliEntry(['node', 'hippo', ...args]));

beforeEach(() => {
  ({ base: home, root } = makeStore('physics-removed'));
  vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// A flag before the query is the case that matters: an undeclared flag there swallows the query as its value.
describe('the removed ranker flags', () => {
  it.each([
    ['recall', 'physics', ['deploy', '--physics']],
    ['recall', 'classic', ['deploy', '--classic']],
    ['recall', 'physics', ['--physics', 'deploy']],
    ['recall', 'classic', ['--classic', 'deploy']],
    ['explain', 'physics', ['deploy', '--physics']],
    ['explain', 'physics', ['--physics', 'deploy']],
    ['explain', 'classic', ['--classic', 'deploy']],
    ['embed', 'reset-physics', ['--reset-physics']],
  ])('%s --%s exits 1 naming the removal (%j)', async (verb, flag, args) => {
    const res = await hippoRun(verb, ...args);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`--${flag} was removed in 3.0`);
  });
});

describe('a physics block in config.json', () => {
  it('is ignored, and the keys beside it still read', () => {
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ physics: { enabled: true, G_query: 3 }, mmr: { lambda: 0.2 } }),
    );

    const config = loadConfig(root);

    expect(config).not.toHaveProperty('physics');
    expect(config.mmr.lambda).toBe(0.2);
  });
});
