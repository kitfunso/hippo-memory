// `hippo init --scan` installs the user-level agent hooks once and leaves every scanned repo's files as they were.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hippoRun } from './_helpers/spawn-hippo.js';
const START = '<!-- hippo:start -->';

let home: string;
let alpha: string;
let beta: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-scan-'));
  alpha = path.join(home, 'code', 'alpha');
  beta = path.join(home, 'code', 'beta');
  // Plain init in either repo would append its block to these files.
  for (const repo of [alpha, beta]) {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude rules\n');
  }
  fs.writeFileSync(path.join(beta, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(beta, 'opencode.json'), '{}\n');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

// Without --no-schedule the run would register a real OS task, without --no-learn it would run git.
function hippo(cwd: string, ...args: string[]): string {
  const r = hippoRun([...args, '--no-schedule', '--no-learn'], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, HIPPO_HOME: path.join(home, 'global') } });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** Each top-level file of a repo with its text, so a patched or new instruction file shows up. */
function files(repo: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(repo, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [entry.name, fs.readFileSync(path.join(repo, entry.name), 'utf8')]));
}

const inHome = (...parts: string[]) => fs.existsSync(path.join(home, ...parts));

describe('hippo init --scan', () => {
  it('installs the Claude Code hooks and the OpenCode plugin once and patches no repo file', () => {
    const before = [files(alpha), files(beta)];
    const out = hippo(home, 'init', '--scan', home);
    const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('hippo session-end');
    expect(settings).toContain('hippo context --pinned-only');
    expect(inHome('.config', 'opencode', 'plugins', 'hippo.ts')).toBe(true);
    expect(out.match(/Auto-installed hippo session-end SessionEnd hook/g)).toHaveLength(1);
    expect([files(alpha), files(beta)]).toEqual(before);
    expect(fs.existsSync(path.join(alpha, '.hippo', 'hippo.db'))).toBe(true);
  });

  it('--no-hooks installs no hook and still creates the stores', () => {
    const out = hippo(home, 'init', '--scan', home, '--no-hooks');
    expect(inHome('.claude')).toBe(false);
    expect(inHome('.config', 'opencode')).toBe(false);
    expect(out).not.toContain('Auto-installed');
    expect(fs.existsSync(path.join(beta, '.hippo', 'hippo.db'))).toBe(true);
  });
});

describe('plain hippo init', () => {
  it('installs the OpenCode plugin on the run that patches AGENTS.md, with one block for every agent', () => {
    hippo(beta, 'init');
    expect(fs.readFileSync(path.join(beta, 'AGENTS.md'), 'utf8').split(START)).toHaveLength(2);
    expect(fs.readFileSync(path.join(beta, 'CLAUDE.md'), 'utf8')).toContain(START);
    expect(inHome('.config', 'opencode', 'plugins', 'hippo.ts')).toBe(true);
  });
});
