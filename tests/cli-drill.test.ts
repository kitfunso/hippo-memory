import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { initStore } from '../src/store/open.js';
import { runInProcess } from './_helpers/run-in-process.js';

const savedCwd = process.cwd();
let home = '';

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('hippo drill CLI', () => {
  it('rejects fractional depth', async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-cli-drill-'));
    initStore(join(home, '.hippo'));
    vi.stubEnv('HIPPO_HOME', join(home, '.hippo-global'));
    process.chdir(home);

    const res = await runInProcess(() => runCli(['node', 'hippo', 'drill', 'missing', '--depth', '1.5']));
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--depth must be an integer between 1 and 10');
  });
});
