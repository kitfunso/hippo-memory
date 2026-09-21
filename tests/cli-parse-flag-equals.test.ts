/** `--flag=value` (glued) form: the first describe unit-tests parseArgs, the second drives the built CLI. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from '../src/cli.js';

const argv = (...rest: string[]) => ['node', 'hippo', ...rest];

describe('parseArgs: --flag=value (glued form)', () => {
  it('case 1: --budget=1500 sets a string value and leaves args empty', () => {
    const { flags, args } = parseArgs(argv('context', '--budget=1500'));
    expect(flags['budget']).toBe('1500');
    expect(args).toEqual([]);
  });

  it('case 2: --budget 1500 (separated form) is unaffected - regression anchor', () => {
    const { flags } = parseArgs(argv('context', '--budget', '1500'));
    expect(flags['budget']).toBe('1500');
  });

  it('case 3: --reason=a=b splits on the FIRST = only', () => {
    const { flags } = parseArgs(argv('remember', '--reason=a=b'));
    expect(flags['reason']).toBe('a=b');
  });

  it('case 4: --tag=a --tag=b (both glued) collects an array', () => {
    const { flags } = parseArgs(argv('remember', '--tag=a', '--tag=b'));
    expect(flags['tag']).toEqual(['a', 'b']);
  });

  it('case 5: --tag=a --tag b (glued then separated) still collects an array', () => {
    const { flags } = parseArgs(argv('remember', '--tag=a', '--tag', 'b'));
    expect(flags['tag']).toEqual(['a', 'b']);
  });

  it('case 6: --scope= (empty glued value) stores boolean true, not an empty string', () => {
    const { flags } = parseArgs(argv('recall', '--scope='));
    expect(flags['scope']).toBe(true);
  });

  it('case 7: --scope=<value> followed by a positional does not eat the positional', () => {
    const { flags, args } = parseArgs(argv('recall', '--scope=slack:private:C1', 'pattern'));
    expect(flags['scope']).toBe('slack:private:C1');
    expect(args).toEqual(['pattern']);
  });

  it('case 8: --reason=--weird stores the literal value verbatim', () => {
    const { flags } = parseArgs(argv('remember', '--reason=--weird'));
    expect(flags['reason']).toBe('--weird');
  });

  it('case 9: --tag=a --tag= (empty glued value on a repeatable key) pushes nothing, keeps prior entries', () => {
    const { flags } = parseArgs(argv('remember', '--tag=a', '--tag='));
    expect(flags['tag']).toEqual(['a']);
  });

  it('case 10: --tag= alone leaves the flag unset, not an array holding an empty string', () => {
    const { flags, args } = parseArgs(argv('remember', '--tag='));
    expect(flags['tag']).toBeUndefined();
    expect(args).toEqual([]);
  });

  it('case 11: --dry-run=false stores the raw string (parser stays total; the guard rejects it downstream)', () => {
    const { flags } = parseArgs(argv('invalidate', '--dry-run=false', 'X'));
    expect(flags['dry-run']).toBe('false');
  });

  it('case 12: --dry-run= (empty) stores an empty string, not boolean true', () => {
    const { flags } = parseArgs(argv('invalidate', '--dry-run='));
    expect(flags['dry-run']).toBe('');
  });

  it('case 13: --dry-run "REST API" (separated form) is unaffected - regression anchor', () => {
    const { flags, args } = parseArgs(argv('invalidate', '--dry-run', 'REST API'));
    expect(flags['dry-run']).toBe(true);
    expect(args).toEqual(['REST API']);
  });

  it('case 14: end-of-flags "--" still works; the = split never sees the literal token', () => {
    const { args } = parseArgs(argv('remember', 'text', '--', '--not-a-flag'));
    expect(args).toEqual(['text', '--not-a-flag']);
  });
});

describe('built CLI: --flag=value end-to-end guards', () => {
  const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  function envWithout(extra: Record<string, string>, ...keys: string[]): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const key of keys) delete result[key];
    return result;
  }

  function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync('node', [CLI, ...args], { cwd: tmpDir, env, encoding: 'utf8' });
      return { stdout, stderr: '', status: 0 };
    } catch (err) {
      // execFileSync attaches stdout/stderr/status to the thrown Error on a non-zero exit.
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hippo-cli-flag-equals-'));
    env = envWithout(
      { HIPPO_HOME: join(tmpDir, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
      'TYPESAFE_API_KEY',
      'HIPPO_TENANT',
    );
    const init = runCli(['init', '--no-hooks', '--no-schedule', '--no-learn']);
    if (init.status !== 0) throw new Error(`setup: hippo init failed: ${init.stderr}`);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('case 15: invalidate --dry-run=false rejects instead of running the destructive path', () => {
    const res = runCli(['invalidate', '--dry-run=false', 'X']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--dry-run takes no value');
  });

  it('case 16: recall --hops= (empty glued value) hits the existing --hops guard', () => {
    const res = runCli(['recall', 'deploy steps', '--hops=']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--hops requires an integer value');
  });

  it('case 17: recall --scope= (empty glued value) hits the existing global --scope guard', () => {
    const res = runCli(['recall', '--scope=', 'x']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--scope requires a non-empty value');
  });

  it('case 18: card create --titl=x (typo) reports the unknown flag with no hint and no "="', () => {
    const res = runCli(['card', 'create', '--titl=x']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown flag --titl');
    expect(res.stderr).not.toContain('=');
  });

  it('case 19: card create --=x (empty key) is left unsplit and reported as one unknown flag', () => {
    const res = runCli(['card', 'create', '--=x']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown flag --=x');
  });

  it('case 20: recall --budget= (empty glued value) is rejected, not silently unbounded', () => {
    const res = runCli(['recall', 'deploy steps', '--budget=']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--budget requires an integer value');
  });

  it('case 20b: recall --budget=abc (junk value) gets a different message than the empty case', () => {
    const res = runCli(['recall', 'deploy steps', '--budget=abc']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Invalid --budget: "abc"');
  });

  it('case 21: recall --budget=0 stays valid (0 is a real bound, not a parse failure)', () => {
    const res = runCli(['recall', 'deploy steps', '--budget=0', '--json']);
    expect(res.status).toBe(0);
  });

  it('case 22: recall --budget abc (separated form) is rejected too, not only the glued form', () => {
    const res = runCli(['recall', 'deploy steps', '--budget', 'abc']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Invalid --budget: "abc"');
  });

  it('case 23: recall --budget=-1 is rejected (a negative bound is not a bound)', () => {
    const res = runCli(['recall', 'deploy steps', '--budget=-1']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Invalid --budget: "-1"');
  });

  it('case 24: assemble --budget=abc errors instead of silently using the api default', () => {
    const res = runCli(['assemble', '--session', 's1', '--budget=abc']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Invalid --budget: "abc"');
  });

  it('case 25: drill --budget=abc errors instead of silently dropping the size cap', () => {
    const res = runCli(['drill', 'no-such-id', '--budget=abc']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Invalid --budget: "abc"');
  });

  it('case 26: share --force=false is rejected, never read as the truthy string "false"', () => {
    const res = runCli(['share', 'no-such-id', '--force=false']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--force takes no value');
  });
});
