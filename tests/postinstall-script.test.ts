import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'postinstall.cjs');

describe('scripts/postinstall.cjs', () => {
  let home: string;
  let binDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-postinstall-'));
    binDir = join(home, 'bin');
    mkdirSync(binDir);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // PATH holds only node's own folder plus an optional fake codex, so the real machine's codex never counts.
  function run(extraEnv: Record<string, string> = {}) {
    const nodeDir = resolve(process.execPath, '..');
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.HIPPO_SKIP_POSTINSTALL;
    const env = { ...base, HOME: home, USERPROFILE: home, HIPPO_HOME: join(home, 'hh'), PATH: [binDir, nodeDir].join(delimiter), ...extraEnv };
    return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  }

  it('is silent and writes nothing when no agent is installed', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(readdirSync(home)).toEqual(['bin']);
  });

  it('prints the Claude Code nudge to stderr and leaves ~/.claude untouched', () => {
    mkdirSync(join(home, '.claude'));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Claude Code detected');
    expect(r.stderr).toContain('hippo init');
    expect(r.stdout).toBe('');
    expect(readdirSync(join(home, '.claude'))).toEqual([]);
  });

  it('stays silent when the hippo hook is already in settings.json, and does not rewrite it', () => {
    mkdirSync(join(home, '.claude'));
    const settings = join(home, '.claude', 'settings.json');
    const body = '{"hooks":"hippo context --pinned-only"}';
    writeFileSync(settings, body);
    const r = run();
    expect(r.stderr).toBe('');
    expect(readFileSync(settings, 'utf8')).toBe(body);
  });

  it('nudges about Codex but never swaps the codex binary', () => {
    const name = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    const fake = join(binDir, name);
    writeFileSync(fake, '#!/bin/sh\necho codex\n');
    chmodSync(fake, 0o755);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('hippo hook install codex');
    expect(readFileSync(fake, 'utf8')).toBe('#!/bin/sh\necho codex\n');
    expect(existsSync(join(home, '.hippo', 'integrations', 'codex.json'))).toBe(false);
  });

  it('HIPPO_SKIP_POSTINSTALL=1 prints nothing even when Claude Code is present', () => {
    mkdirSync(join(home, '.claude'));
    const r = run({ HIPPO_SKIP_POSTINSTALL: '1' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
