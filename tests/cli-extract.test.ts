import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

function hippo(env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
}

describe('hippo remember --extract', () => {
  let home: string;
  let env: Record<string, string>;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('saves memory even when extraction skips (no API key)', () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-extract-'));
    env = { HIPPO_HOME: join(home, '.hippo'), ANTHROPIC_API_KEY: '' };
    hippo(env, 'init', '--no-hooks', '--no-schedule', '--no-learn');

    let stderr = '';
    try {
      execFileSync('node', [HIPPO_BIN, 'remember', 'John loves basketball', '--extract'], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        shell: process.platform === 'win32',
      });
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? '');
    }

    const out = hippo(env, 'recall', 'basketball', '--json');
    expect(out).toContain('basketball');
  });

  it('remember works without --extract flag', () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-extract-'));
    env = { HIPPO_HOME: join(home, '.hippo'), ANTHROPIC_API_KEY: '' };
    hippo(env, 'init', '--no-hooks', '--no-schedule', '--no-learn');

    hippo(env, 'remember', 'Alice enjoys reading');

    const out = hippo(env, 'recall', 'reading', '--json');
    expect(out).toContain('reading');
  });
});
