import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

// `cwd` MUST be an isolated temp dir. The CLI resolves the local store by
// walking up from cwd to find `.hippo`; without isolation it finds the real
// project store. HIPPO_HOME only redirects the *global* store, so it cannot
// substitute for cwd isolation here.
function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    cwd,
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
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');

    let stderr = '';
    try {
      execFileSync('node', [HIPPO_BIN, 'remember', 'John loves basketball', '--extract'], {
        cwd: home,
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        shell: process.platform === 'win32',
      });
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? '');
    }

    const out = hippo(home, env, 'recall', 'basketball', '--json');
    expect(out).toContain('basketball');
  });

  it('remember works without --extract flag', () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-extract-'));
    env = { HIPPO_HOME: join(home, '.hippo'), ANTHROPIC_API_KEY: '' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');

    hippo(home, env, 'remember', 'Alice enjoys reading');

    const out = hippo(home, env, 'recall', 'reading', '--json');
    expect(out).toContain('reading');
  });
});
