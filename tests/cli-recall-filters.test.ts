import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

function hippo(env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

describe('recall --layer filter (v0.30.1)', () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-layer-'));
    env = { HIPPO_HOME: join(home, '.hippo') };
    hippo(env, 'init');
  });

  it('--layer trace excludes non-trace entries', () => {
    hippo(env, 'remember', 'red herring episodic about deploys');
    hippo(env, 'trace', 'record', '--task', 'deploy', '--steps', '[{"action":"x","observation":"y"}]', '--outcome', 'success');

    const out = hippo(env, 'recall', 'deploy', '--layer', 'trace', '--limit', '5');

    expect(out).toContain('[trace]');
    expect(out).not.toContain('[episodic]');
    rmSync(home, { recursive: true, force: true });
  });

  it('--layer rejects invalid value', () => {
    let err = '';
    try {
      hippo(env, 'recall', 'anything', '--layer', 'bogus');
    } catch (e) {
      err = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    expect(err).toMatch(/Invalid --layer/);
    rmSync(home, { recursive: true, force: true });
  });
});
