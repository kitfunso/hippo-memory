import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

describe('recall --layer filter (v0.30.1)', () => {
  let home: string;
  let env: Record<string, string>;

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
      err = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(err).toMatch(/Invalid --layer/);
  });
});
