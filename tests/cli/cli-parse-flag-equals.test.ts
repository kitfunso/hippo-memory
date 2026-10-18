/** `--flag=value` (glued) form: the first describe unit-tests parseArgs, the last runs the whole CLI entry in process. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectVerbReads } from '../../scripts/cli-flag-reads.mjs';
import { parseArgs, runCli as runCliEntry, shouldAutoRepairCodexWrapper } from '../../src/cli.js';
import { COMMANDS } from '../../src/cli/verbs.js';
import { undeclaredFlags, type VerbFlags } from '../../src/cli/flags.js';
import { ownStderr } from '../_helpers/own-stderr.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

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

  it('case 14g: a flag two verbs read differently parses by the verb typed, and as a value on a verb that reads neither', () => {
    expect(parseArgs(argv('last-sleep', '--keep', 'x'))).toMatchObject({ flags: { keep: true }, args: ['x'] });
    expect(parseArgs(argv('resolve', '7', '--keep', 'mem_1'))).toMatchObject({ flags: { keep: 'mem_1' }, args: ['7'] });
    expect(parseArgs(argv('status', '--keep', 'x'))).toMatchObject({ flags: { keep: 'x' }, args: [] });
  });
});

describe('per-verb flags: each row of COMMANDS declares what its verb reads', () => {
  // The walker follows the flags object out of each row's handler and never looks at a declaration.
  let found: ReturnType<typeof collectVerbReads>;
  const rows: Record<string, { readonly flags: VerbFlags }> = COMMANDS;
  const namesOf = (flags: VerbFlags): string[] => [
    ...(flags.switches ?? []),
    ...(flags.values ?? []),
    ...(flags.numbers ?? []),
    ...(flags.lists ?? []),
  ];
  // The walker builds a TypeScript program over all of src/, which is pure CPU and slowest on a shared runner.
  beforeAll(() => {
    found = collectVerbReads(resolve(__dirname, '..', '..'));
  }, 120_000);

  it('case 14d: a flag a verb reads only as on/off is a switch on that verb, so no value can switch it on', () => {
    expect(found.unclassed).toEqual([]);
    const wrongKind: string[] = [];
    for (const { verb, flags } of found.verbs) {
      const switches = rows[verb]?.flags.switches ?? [];
      for (const [name, read] of Object.entries(flags)) {
        if (read === 'on-off' && !switches.includes(name)) {
          wrongKind.push(`${verb} --${name} is read as on/off and is not a switch`);
        }
        if (read === 'value' && switches.includes(name)) {
          wrongKind.push(`${verb} --${name} is a switch and its value is read`);
        }
      }
    }
    expect(wrongKind).toEqual([]);
  });

  it('case 14e: each verb declares exactly the flags it reads, so no declared flag is dead and no read flag is missing', () => {
    expect(found.unfollowed).toEqual([]);
    const read = Object.fromEntries(found.verbs.map(({ verb, flags }) => [verb, Object.keys(flags).sort()]));
    const declared = Object.fromEntries(Object.entries(rows).map(([verb, { flags }]) => [verb, namesOf(flags).sort()]));
    expect(declared).toEqual(read);
  });

  it('case 14h: every verb is silent on each flag it declares and names one flag that only another verb declares', () => {
    const everyFlag = [...new Set(Object.values(rows).flatMap(({ flags }) => namesOf(flags)))].sort();
    const wrong: string[] = [];
    for (const [verb, { flags }] of Object.entries(rows)) {
      const own = namesOf(flags);
      const foreign = everyFlag.find((name) => !own.includes(name)) ?? '';
      const ignored = undeclaredFlags(flags, [...own, foreign]);
      if (ignored.length !== 1 || ignored[0] !== foreign) {
        wrong.push(`${verb} is told it ignores: ${ignored.join(', ')}`);
      }
    }
    expect(wrong).toEqual([]);
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

describe('runCli: --flag=value end-to-end guards', () => {
  const savedCwd = process.cwd();
  let tmpDir: string;

  const runCli = (args: string[]): Promise<InProcessResult> =>
    runInProcess(() => runCliEntry(['node', 'hippo', ...args]));

  beforeEach(() => {
    tmpDir = makeStore('cli-flag-equals').base;
    vi.stubEnv('HIPPO_HOME', join(tmpDir, 'global-hippo'));
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_TENANT', '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
  });

  it.each([
    {
      id: '15',
      args: ['invalidate', '--dry-run=false', 'X'],
      flag: 'dry-run',
      why: 'rejects instead of running the destructive path',
    },
    {
      id: '26',
      args: ['share', 'no-such-id', '--force=false'],
      flag: 'force',
      why: 'is never read as the truthy string "false"',
    },
    { id: '27', args: ['audit', '--fix=false'], flag: 'fix', why: 'is rejected before any memory is deleted' },
    {
      id: '28',
      args: ['remember', 'use pnpm', '--pin', 'true'],
      flag: 'pin',
      why: 'is not stored as the text "use pnpm true"',
    },
    {
      id: '28b',
      args: ['last-sleep', '--keep=false'],
      flag: 'keep',
      why: 'is never read as the truthy string that keeps the log',
    },
  ])('case $id: a valued switch --$flag $why', async ({ args, flag }) => {
    const res = await runCli(args);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`--${flag} takes no value`);
  });

  it.each([
    {
      id: '16',
      args: ['recall', 'deploy steps', '--hops='],
      message: '--hops requires an integer value',
      why: 'an empty glued value hits the --hops guard',
    },
    {
      id: '20',
      args: ['recall', 'deploy steps', '--budget='],
      message: '--budget requires an integer value',
      why: 'an empty glued value is not silently unbounded',
    },
    {
      id: '20b',
      args: ['recall', 'deploy steps', '--budget=abc'],
      message: 'Invalid --budget: "abc"',
      why: 'a junk value gets a different message than the empty case',
    },
    {
      id: '22',
      args: ['recall', 'deploy steps', '--budget', 'abc'],
      message: 'Invalid --budget: "abc"',
      why: 'the separated form is rejected too',
    },
    {
      id: '23',
      args: ['recall', 'deploy steps', '--budget=-1'],
      message: 'Invalid --budget: "-1"',
      why: 'a negative bound is not a bound',
    },
    {
      id: '24',
      args: ['assemble', '--session', 's1', '--budget=abc'],
      message: 'Invalid --budget: "abc"',
      why: 'assemble errors instead of using the api default',
    },
    {
      id: '25',
      args: ['drill', 'no-such-id', '--budget=abc'],
      message: 'Invalid --budget: "abc"',
      why: 'drill errors instead of dropping the size cap',
    },
  ])('case $id: $why', async ({ args, message }) => {
    const res = await runCli(args);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(message);
  });

  it('case 18: card create --titl=x (typo) reports the unknown flag with no hint and no "="', async () => {
    const res = await runCli(['card', 'create', '--titl=x']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown flag --titl');
    expect(res.stderr).not.toContain('=');
  });

  it('case 19: card create --=x (empty key) is left unsplit and reported as one unknown flag', async () => {
    const res = await runCli(['card', 'create', '--=x']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown flag --=x');
  });

  it('case 21: recall --budget=0 stays valid (0 is a real bound, not a parse failure)', async () => {
    const res = await runCli(['recall', 'deploy steps', '--budget=0', '--json']);
    expect(res.status).toBe(0);
  });

  it('case 29: forget X --dryrun (typo) stops with exit 2 instead of forgetting', async () => {
    const res = await runCli(['forget', 'X', '--dryrun']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Unknown flag --dryrun for hippo forget. Nothing was changed.');
  });

  it('case 30: recall --limt (typo) on a read-only command warns and still runs', async () => {
    const res = await runCli(['recall', 'deploy steps', '--limt', '5', '--json']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('ignoring unknown flag --limt');
  });

  it('case 30b: a flag another verb reads warns once on a verb that ignores it, and the verb runs as before', async () => {
    const plain = await runCli(['recall', 'deploy steps', '--json']);
    const res = await runCli(['recall', 'deploy steps', '--json', '--archive']);
    expect(plain.stderr).not.toContain('ignoring unknown flag');
    expect(res.stderr.split('\n').filter((line) => line.includes('ignoring unknown flag'))).toEqual([
      'hippo: ignoring unknown flag --archive. A later release will reject it.',
    ]);
    expect({ status: res.status, stdout: res.stdout }).toEqual({ status: 0, stdout: plain.stdout });
  });

  it('case 30c: a destructive verb is not refused over a flag another verb reads; it warns and runs', async () => {
    const plain = await runCli(['forget', 'no-such-id']);
    const res = await runCli(['forget', 'no-such-id', '--json']);
    const plainStderr = ownStderr(plain.stderr);
    expect(ownStderr(res.stderr)).toBe(
      `hippo: ignoring unknown flag --json. A later release will reject it.\n${plainStderr}`,
    );
    expect({ status: res.status, stdout: res.stdout }).toEqual({ status: plain.status, stdout: plain.stdout });
    expect(plainStderr).toContain('Memory not found: no-such-id');
  });

  it('case 30d: a --dry-run the verb lacks is refused by name only, never also called ignored', async () => {
    expect((await runCli(['reject', 'X', '--dry-run'])).stderr).not.toContain('ignoring unknown flag');
  });

  it.each([
    {
      id: '31',
      args: ['reject', 'X', '--dry-run'],
      message: 'hippo reject has no --dry-run',
      why: 'reject has no dry run',
    },
    {
      id: '33',
      args: ['share', 'X', '--dry-run'],
      message: 'hippo share has no --dry-run outside `hippo share --auto`',
      why: 'share <id> would share for real',
    },
    {
      id: '34',
      args: ['brief', 'close', '1', '--dry-run'],
      message: 'hippo brief has no --dry-run outside `hippo brief refresh`',
      why: 'brief close would close the brief',
    },
  ])('case $id: --dry-run stops with exit 2, because $why', async ({ args, message }) => {
    const res = await runCli(args);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(message);
  });

  it('case 35: share --auto and brief refresh keep their dry runs', async () => {
    const share = await runCli(['share', '--auto', '--dry-run']);
    expect(share.status).toBe(0);
    expect(share.stderr).not.toContain('has no --dry-run');
    expect((await runCli(['brief', 'refresh', 'my-repo', '--dry-run'])).stderr).not.toContain('has no --dry-run');
  });

  it('case 36: sleep --dry-run imports no MEMORY.md file and learns no commits', async () => {
    const home = join(tmpDir, 'home');
    const memDir = join(home, '.claude', 'projects', 'p', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'note.md'),
      '---\nname: note\ntype: reference\n---\nThe staging deploy waits for the friday freeze.\n',
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);

    const res = await runCli(['sleep', '--dry-run']);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Dry run: skipped learning');
    expect(loadAllEntries(join(tmpDir, '.hippo'), 'default')).toEqual([]);
  });
});
