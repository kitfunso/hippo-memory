import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';

const savedCwd = process.cwd();
const hippo = (...args: string[]) => runInProcess(() => runCli(['node', 'hippo', ...args]));

describe('hippo remember --extract', () => {
  let home: string;

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('saves memory even when extraction skips (no API key)', async () => {
    // `cwd` MUST be an isolated temp dir: the CLI walks up from cwd to find `.hippo`, and HIPPO_HOME only moves the global store.
    home = mkdtempSync(join(tmpdir(), 'hippo-extract-'));
    vi.stubEnv('HIPPO_HOME', join(home, '.hippo'));
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    process.chdir(home);
    const init = await hippo('init', '--no-hooks', '--no-schedule', '--no-learn');
    expect(init.status, init.stderr).toBe(0);

    // Without an API key --extract may exit non-zero; the recall below is the check.
    await hippo('remember', 'John loves basketball', '--extract');

    const recall = await hippo('recall', 'basketball', '--json');
    expect(recall.status, recall.stderr).toBe(0);
    expect(recall.stdout).toContain('basketball');
  });
});
