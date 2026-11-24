import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
const START = '<!-- hippo:start -->';

const savedCwd = process.cwd();
let home: string;
let alpha: string;
let beta: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-scan-'));
  alpha = path.join(home, 'code', 'alpha');
  beta = path.join(home, 'code', 'beta');
  for (const repo of [alpha, beta]) {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude rules\n');
  }
  fs.writeFileSync(path.join(beta, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(beta, 'opencode.json'), '{}\n');
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

async function hippo(cwd: string, ...args: string[]): Promise<string> {
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('HIPPO_HOME', path.join(home, 'global'));
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args, '--no-schedule', '--no-learn']));
    expect(r.status || Number(process.exitCode ?? 0), r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.exitCode = undefined;
  }
}

function files(repo: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(repo, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, fs.readFileSync(path.join(repo, entry.name), 'utf8')]),
  );
}

const inHome = (...parts: string[]) => fs.existsSync(path.join(home, ...parts));

describe('hippo init --scan', () => {
  it('installs the Claude Code hooks and the OpenCode plugin once and patches no repo file', async () => {
    const before = [files(alpha), files(beta)];
    const out = await hippo(home, 'init', '--scan', home);
    const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('hippo session-end');
    expect(settings).toContain('hippo context --pinned-only');
    expect(inHome('.config', 'opencode', 'plugins', 'hippo.ts')).toBe(true);
    expect(out.match(/Auto-installed hippo session-end SessionEnd hook/g)).toHaveLength(1);
    expect([files(alpha), files(beta)]).toEqual(before);
    expect(fs.existsSync(path.join(alpha, '.hippo', 'hippo.db'))).toBe(true);
  });

  it('--no-hooks installs no hook and still creates the stores', async () => {
    const out = await hippo(home, 'init', '--scan', home, '--no-hooks');
    expect(inHome('.claude')).toBe(false);
    expect(inHome('.config', 'opencode')).toBe(false);
    expect(out).not.toContain('Auto-installed');
    expect(fs.existsSync(path.join(beta, '.hippo', 'hippo.db'))).toBe(true);
  });
});

describe('plain hippo init', () => {
  it('installs the OpenCode plugin on the run that patches AGENTS.md, with one block for every agent', async () => {
    await hippo(beta, 'init');
    expect(fs.readFileSync(path.join(beta, 'AGENTS.md'), 'utf8').split(START)).toHaveLength(2);
    expect(fs.readFileSync(path.join(beta, 'CLAUDE.md'), 'utf8')).toContain(START);
    expect(inHome('.config', 'opencode', 'plugins', 'hippo.ts')).toBe(true);
  });
});
