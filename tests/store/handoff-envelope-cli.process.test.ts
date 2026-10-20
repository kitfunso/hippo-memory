// W1 handoff envelope: `hippo handoff create` then `handoff latest --json` through the built CLI.
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

describe('CLI round trip: handoff create -> handoff latest --json', () => {
  const REPO_ROOT = join(__dirname, '..', '..');
  const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

  beforeAll(() => {
    if (!existsSync(CLI_PATH) || !statSync(CLI_PATH).isFile()) {
      throw new Error(`dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`);
    }
  });

  function toUtf8(value: string | Buffer | undefined): string {
    if (value === undefined) return '';
    return Buffer.isBuffer(value) ? value.toString('utf8') : value;
  }

  function runCli(cwd: string, env: Record<string, string>, ...args: string[]) {
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
        cwd,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { out: stdout, status: 0 };
    } catch (e) {
      // SAFETY: execFileSync throws this exact shape (stdout/stderr/status) on a non-zero exit.
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
      return { out: toUtf8(err.stdout) + toUtf8(err.stderr), status: err.status ?? 1 };
    }
  }

  // Shared by every CLI case below: a throwaway git repo plus an initialised hippo store.
  function setupCliHome() {
    const home = mkdtempSync(join(tmpdir(), 'hippo-w1-cli-'));
    const globalDir = join(home, 'global');
    mkdirSync(globalDir, { recursive: true });
    const env = { HIPPO_HOME: globalDir };
    execSync('git init', { cwd: home, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: home, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: home, stdio: 'ignore' });
    execSync('git commit --allow-empty -m "init"', { cwd: home, stdio: 'ignore' });
    const init = runCli(home, env, 'init');
    expect(init.status, init.out).toBe(0);
    return { home, env };
  }

  it('round-trips every new flag and returns a 40-char git ref', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(
        home,
        env,
        'handoff',
        'create',
        '--summary',
        's',
        '--constraint',
        'a',
        '--constraint',
        'b',
        '--outcome',
        'partial',
        '--target-runtime',
        'codex',
        '--card-id',
        'c1',
        '--tests',
        'pass',
      );
      expect(create.status, create.out).toBe(0);

      const latest = runCli(home, env, 'handoff', 'latest', '--json');
      expect(latest.status, latest.out).toBe(0);
      const { handoff } = JSON.parse(latest.out);
      expect(handoff.summary).toBe('s');
      expect(handoff.constraints).toEqual(['a', 'b']);
      expect(handoff.outcome).toBe('partial');
      expect(handoff.targetRuntime).toBe('codex');
      expect(handoff.cardId).toBe('c1');
      expect(handoff.evidence.testStatus).toBe('pass');
      expect(handoff.evidence.gitRef).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a value-less --target-runtime instead of persisting the string "true"', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'handoff', 'create', '--summary', 's', '--target-runtime');
      expect(create.status, create.out).toBe(1);
      expect(create.out).toContain('--target-runtime requires a value');

      const latest = runCli(home, env, 'handoff', 'latest', '--json');
      expect(latest.status, latest.out).toBe(0);
      expect(JSON.parse(latest.out)).toEqual({ handoff: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a value-less --card-id when another flag follows it', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'handoff', 'create', '--card-id', '--summary', 's');
      expect(create.status, create.out).toBe(1);
      expect(create.out).toContain('--card-id requires a value');

      const latest = runCli(home, env, 'handoff', 'latest', '--json');
      expect(latest.status, latest.out).toBe(0);
      expect(JSON.parse(latest.out)).toEqual({ handoff: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
