// 3.0 removed the physics engine: its flags fail by name, --classic only warns, and a physics config block is ignored.
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

describe('the physics flags', () => {
  it.each([
    ['recall --physics', ['recall', 'deploy', '--physics'], '--physics was removed in 3.0'],
    ['explain --physics', ['explain', 'deploy', '--physics'], '--physics was removed in 3.0'],
    ['embed --reset-physics', ['embed', '--reset-physics'], '--reset-physics was removed in 3.0'],
  ])('%s exits 1 naming the removal', async (_name, args, removal) => {
    const res = await hippoRun(...args);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain(removal);
  });

  it('recall --classic warns that the flag is unknown and still recalls', async () => {
    const res = await hippoRun('recall', 'deploy', '--classic');

    expect(res.status).toBe(0);
    expect(res.stderr).toContain('ignoring unknown flag --classic');
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
