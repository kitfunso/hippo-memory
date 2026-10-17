// L1 `recall --graph-stream` range checks the golden matrix misses (docs/plans/2026-06-02-l1-graph-rrf-stream.md).
// The flag on a real store and the non-integer cases are pinned in tests/cli-recall-golden.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';

/** `hippo <args>` run in this process from `cwd`, the call bin/hippo.js makes. */
async function hippo(cwd: string, ...args: string[]) {
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    return await runInProcess(() => runCli(['node', 'hippo', ...args]));
  } finally {
    process.chdir(saved);
  }
}

describe('recall --graph-stream', () => {
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-l1cli-'));
    vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    expect((await hippo(home, 'init', '--no-hooks', '--no-schedule', '--no-learn')).status).toBe(0);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ['--graph-hops', '99', /Invalid --graph-hops/],
    ['--graph-seeds', '0', /Invalid --graph-seeds/],
  ])('%s %s is rejected', async (flag, value, message) => {
    const r = await hippo(home, 'recall', 'anything', '--graph-stream', flag, value);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(message);
  });
});
