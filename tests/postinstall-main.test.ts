// src/postinstall.ts runs main() on import, so each case points HOME and PATH at a temp dir and imports it fresh.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

let home: string;
let stderr: MockInstance;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-postinstall-main-'));
  mkdirSync(join(home, 'bin'));
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, HIPPO_HOME: join(home, '.hippo'), CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: '', HIPPO_SKIP_POSTINSTALL: '', PATH: join(home, 'bin'),
  })) vi.stubEnv(key, value);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function runPostinstall(): Promise<string> {
  vi.resetModules();
  await import('../src/postinstall.js');
  return stderr.mock.calls.map((call) => String(call[0])).join('');
}

describe('postinstall main', () => {
  it('prints the Claude Code and Codex nudges when both are present and neither is wired', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, 'bin', 'codex'), '');
    const out = await runPostinstall();
    expect(out).toContain('hippo-memory installed. Claude Code detected on this machine.');
    expect(out).toContain('    hippo init --global\n');
    expect(out).toContain('Codex CLI detected on this machine.');
    expect(out).toContain('    hippo hook install codex\n');
  });

  it('stays silent when the hook is already in settings.json and Codex is absent', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), '{"hooks":"hippo context --pinned-only"}');
    expect(await runPostinstall()).toBe('');
  });

  it('prints nothing at all with HIPPO_SKIP_POSTINSTALL=1', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, 'bin', 'codex'), '');
    vi.stubEnv('HIPPO_SKIP_POSTINSTALL', '1');
    expect(await runPostinstall()).toBe('');
  });
});
