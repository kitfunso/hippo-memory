import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hippoOut } from './_helpers/spawn-hippo.js';

interface HippoEnv {
  HIPPO_HOME: string;
  HIPPO_SKIP_AUTO_INTEGRATIONS?: string;
}

function hippo(cwd: string, env: HippoEnv, ...args: string[]): string {
  return hippoOut(args, { cwd, env: { ...process.env, ...env }, exe: 'node' });
}

describe('recall --layer filter (v0.30.1)', () => {
  let home: string;
  let env: HippoEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-layer-'));
    env = {
      HIPPO_HOME: join(home, 'global-hippo'),
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('--layer trace excludes non-trace entries', () => {
    hippo(home, env, 'remember', 'red herring episodic about deploys');
    hippo(home, env, 'trace', 'record', '--task', 'deploy', '--steps', '[{"action":"x","observation":"y"}]', '--outcome', 'success');

    const out = hippo(home, env, 'recall', 'deploy', '--layer', 'trace', '--limit', '5');

    expect(out).toContain('[trace]');
    expect(out).not.toContain('[episodic]');
  });

  it('--layer rejects invalid value', () => {
    let err = '';
    try {
      hippo(home, env, 'recall', 'anything', '--layer', 'bogus');
    } catch (e) {
      // SAFETY: execFileSync on failure throws an Error augmented with a
      // stderr Buffer per Node's child_process API contract.
      err = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(err).toMatch(/Invalid --layer/);
  });
});
