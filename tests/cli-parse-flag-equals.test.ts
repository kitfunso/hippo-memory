/** `--flag=value` (glued) form: the first describe unit-tests parseArgs, the second drives the built CLI. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BOOLEAN_FLAGS, KNOWN_FLAGS, parseArgs, shouldAutoRepairCodexWrapper } from '../src/cli.js';

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

  it('case 14b: a switch never swallows the token after it', () => {
    const { flags, args } = parseArgs(argv('recall', '--json', 'deploy steps'));
    expect(flags['json']).toBe(true);
    expect(args).toEqual(['deploy steps']);
  });

  it('case 14c: a bare true or false after a switch is kept as its value, for main() to reject', () => {
    expect(parseArgs(argv('remember', 'x', '--pin', 'true')).flags['pin']).toBe('true');
    expect(parseArgs(argv('audit', '--fix', 'false')).flags['fix']).toBe('false');
  });
});

describe('BOOLEAN_FLAGS: every switch the CLI reads is registered', () => {
  // SHORTCUT: idiom regexes, not a type check; a switch read only through a local variable slips past.
  const ON_OFF = /Boolean\(\s*<>|<>\s*[!=]==\s*true|!\s*<>|if \(\s*<>\s*\)|<>\s*\?(?![?.])|&&\s*<>|<>\s*&&|\|\|\s*<>/;
  const AS_VALUE = /String\(\s*<>|Number\(\s*<>|parse\w*\(\s*<>|<>\s*as string|typeof <>|<>\.\w|`[^`]*\$\{\s*<>/;

  it('case 14d: a flag read only as on/off is in BOOLEAN_FLAGS, so no value can switch it on', () => {
    const onOff = new Set<string>();
    const asValue = new Set<string>();
    for (const file of ['cli.ts', join('connectors', 'github', 'cli-impl.ts')]) {
      const src = readFileSync(resolve(__dirname, '..', 'src', file), 'utf8');
      for (const m of src.matchAll(/flags\[['"]([a-z0-9-]+)['"]\]/g)) {
        const at = m.index ?? 0;
        const read = `${src.slice(Math.max(0, at - 40), at)}<>${src.slice(at + m[0].length, at + m[0].length + 30)}`;
        if (AS_VALUE.test(read)) asValue.add(m[1]);
        else if (ON_OFF.test(read)) onOff.add(m[1]);
      }
    }
    const unregistered = [...onOff].filter((key) => !asValue.has(key) && !BOOLEAN_FLAGS.has(key));
    expect(unregistered).toEqual([]);
  });

  it('case 14e: KNOWN_FLAGS is exactly the set of flags the CLI reads, so no typo hides in it', () => {
    const reads = new Set<string>();
    const READ = /flags(?:\[['"]([a-z0-9-]+)['"]\]|\.([a-z][a-z0-9]*)\b)|(?:Flag|hasOwn)\(\s*flags,\s*['"]([a-z0-9-]+)['"]/g;
    for (const file of ['cli.ts', join('connectors', 'github', 'cli-impl.ts')]) {
      const src = readFileSync(resolve(__dirname, '..', 'src', file), 'utf8');
      for (const m of src.matchAll(READ)) reads.add(m[1] ?? m[2] ?? m[3]);
    }
    expect([...reads].sort()).toEqual([...KNOWN_FLAGS].sort());
  });
});

describe('init --no-hooks', () => {
  it('case 14f: skips the codex wrapper repair, read from the parsed flags', () => {
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '');
    try {
      expect(shouldAutoRepairCodexWrapper('init', parseArgs(argv('init')).flags)).toBe(true);
      expect(shouldAutoRepairCodexWrapper('init', parseArgs(argv('init', '--no-hooks')).flags)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
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
    const res = spawnSync('node', [CLI, ...args], { cwd: tmpDir, env, encoding: 'utf8' });
    return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
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

  it('case 27: audit --fix=false is rejected before any memory is deleted', () => {
    const res = runCli(['audit', '--fix=false']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--fix takes no value');
  });

  it('case 28: remember --pin true is rejected, not stored as the text "use pnpm true"', () => {
    const res = runCli(['remember', 'use pnpm', '--pin', 'true']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--pin takes no value');
  });

  it('case 29: forget X --dryrun (typo) stops with exit 2 instead of forgetting', () => {
    const res = runCli(['forget', 'X', '--dryrun']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Unknown flag --dryrun for hippo forget. Nothing was changed.');
  });

  it('case 30: recall --limt (typo) on a read-only command warns and still runs', () => {
    const res = runCli(['recall', 'deploy steps', '--limt', '5', '--json']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('ignoring unknown flag --limt');
  });

  it('case 31: reject --dry-run stops with exit 2, because reject has no dry run', () => {
    const res = runCli(['reject', 'X', '--dry-run']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('hippo reject has no --dry-run');
  });

  it('case 32: importing dist/cli.js runs nothing; only bin/hippo.js and a direct run do', () => {
    const url = pathToFileURL(resolve(__dirname, '..', 'dist', 'cli.js')).href;
    const res = spawnSync('node', ['-e', `import(${JSON.stringify(url)}).then(() => console.log('imported'))`], {
      cwd: tmpDir, env, encoding: 'utf8',
    });
    expect(res.stdout.trim()).toBe('imported');
  });
});
