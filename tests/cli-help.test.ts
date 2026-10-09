// Pins the exact stdout, stderr and exit code of every help and unknown-verb form, and that --help runs no verb.
// In-process, since a spawn per form cost about a minute of CI time; one spawned run keeps the built binary in the loop.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { COMMANDS, parseArgs, runCli, usageText, verbUsage } from '../src/cli.js';
import { VERB_FLAGS, type VerbFlags } from '../src/cli/flags.js';
import { VERB_USAGE } from '../src/cli/usage.js';
import { ownStderr } from './_helpers/own-stderr.js';
import { runInProcess, type InProcessResult } from './_helpers/run-in-process.js';

// Read from the dispatch table so a verb added later is covered without editing this file.
const VERBS = Object.entries(COMMANDS).flatMap(([verb, spec]) => [verb, ...(spec.aliases ?? [])]);
const SUBCOMMANDS = [['audit', 'prune'], ['slack', 'backfill'], ['slack', 'workspaces'], ['github', 'backfill']];
const OWN_FLAG = new Map([
  ['audit prune', '--older-than'], ['slack backfill', '--channel'], ['slack workspaces', '--tenant'], ['github backfill', '--repo'],
]);
const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');
// No PATH, so a spawned verb that ignored --help could not reach schtasks, crontab or codex.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
const ISOLATED_KEYS = ['HOME', 'USERPROFILE', 'HIPPO_HOME', 'HIPPO_SKIP_AUTO_INTEGRATIONS'];

// No-op spies, so a verb that ignored --help is caught without running.
const handlers = Object.entries<{ run: (...args: never[]) => void | Promise<void> }>(COMMANDS)
  .map(([verb, spec]) => [verb, vi.spyOn(spec, 'run').mockImplementation(() => undefined)] as const);

interface CommandRow { readonly usage: readonly string[]; readonly flags: VerbFlags }
interface HelpDirs { readonly cwd: string; readonly home: string; readonly store: string }
let dirs: HelpDirs;
let full: InProcessResult;
const savedCwd = process.cwd();
const savedEnv = Object.fromEntries(ISOLATED_KEYS.map((key) => [key, process.env[key]]));

interface HelpRun extends InProcessResult { readonly ran: string[]; readonly written: string[] }

function written(): string[] {
  const paths = Object.values(dirs).flatMap((dir) => readdirSync(dir).map((name) => join(dir, name)));
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  return paths;
}

async function run(args: string[]): Promise<HelpRun> {
  const res = await runInProcess(() => runCli(['node', 'hippo', ...args]));
  const ran = handlers.filter(([, spy]) => spy.mock.calls.length > 0).map(([verb]) => verb);
  for (const [, spy] of handlers) spy.mockClear();
  return { ...res, ran, written: written() };
}

const pick = ({ status, stdout, stderr }: InProcessResult): InProcessResult => ({ status, stdout, stderr });
// The full listing is pinned once, under hippo --help; every other snapshot names it instead of repeating it.
const pinned = (res: InProcessResult): InProcessResult => ({ ...pick(res), stdout: res.stdout === full.stdout ? '<full usage>' : res.stdout });

beforeAll(async () => {
  dirs = { cwd: mkdtempSync(join(tmpdir(), 'hippo-help-cwd-')), home: mkdtempSync(join(tmpdir(), 'hippo-help-home-')), store: mkdtempSync(join(tmpdir(), 'hippo-help-store-')) };
  Object.assign(process.env, { HOME: dirs.home, USERPROFILE: dirs.home, HIPPO_HOME: dirs.store, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' });
  process.chdir(dirs.cwd);
  full = pick(await run(['--help']));
});

afterAll(() => {
  process.chdir(savedCwd);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  for (const [, spy] of handlers) spy.mockRestore();
});

describe('CLI help output is byte-identical and runs nothing', () => {
  it('hippo --help', () => {
    expect(full).toMatchSnapshot();
  });

  it('the dispatch table holds the pinned verbs, so a dropped verb fails here', () => {
    expect([...VERBS].sort()).toMatchSnapshot();
  });

  it.for(Object.entries<CommandRow>(COMMANDS))('%s takes its help blocks and flags from its own key', ([verb, spec]) => {
    const usage: Readonly<Record<string, readonly string[]>> = VERB_USAGE;
    const flags: Readonly<Record<string, VerbFlags>> = VERB_FLAGS;
    expect(spec.usage).toEqual(usage[verb] ?? []);
    if (usage[verb]) expect(spec.usage).toBe(usage[verb]);
    expect(spec.flags).toBe(flags[verb]);
  });

  it.for([{ args: [] }, { args: ['-h'] }, { args: ['help'] }, { args: ['--help'] }])('hippo $args prints the same full usage', async ({ args }) => {
    const res = await run(args);
    expect(pick(res)).toEqual(full);
    expect(res.stdout).toBe(`${usageText()}\n`);
    expect([res.ran, res.written]).toEqual([[], []]);
  });

  it.for(VERBS)('hippo help %s prints the full usage', async (verb) => {
    const res = await run(['help', verb]);
    expect(pick(res)).toEqual(full);
    expect([res.ran, res.written]).toEqual([[], []]);
  });

  it.for(VERBS)('hippo %s --help', async (verb) => {
    const res = await run([verb, '--help']);
    expect(res.ran, 'a handler ran').toEqual([]);
    expect(res.written).toEqual([]);
    expect(res.stdout).toBe(`${verbUsage(verb) ?? usageText()}\n`);
    expect(pinned(res)).toMatchSnapshot();
  });

  it('hippo init -h prints the init block and installs nothing', async () => {
    const res = await run(['init', '-h']);
    expect(pick(res)).toEqual({ status: 0, stdout: `${verbUsage('init')}\n`, stderr: '' });
    expect([res.ran, res.written]).toEqual([[], []]);
  });

  it.for(SUBCOMMANDS)('hippo %s %s --help', async ([verb, sub]) => {
    const res = await run([verb, sub, '--help']);
    expect(res.stdout).toContain(OWN_FLAG.get(`${verb} ${sub}`));
    expect([res.ran, res.written]).toEqual([[], []]);
    expect(pinned(res)).toMatchSnapshot();
  });

  it('hippo slack workspaces add --help prints the workspaces usage and runs nothing', async () => {
    const [res, workspaces] = [await run(['slack', 'workspaces', 'add', '--help']), await run(['slack', 'workspaces', '--help'])];
    expect(pick(res)).toEqual(pick(workspaces));
    expect([res.ran, res.written]).toEqual([[], []]);
  });

  it.for([{ args: ['frobnicate'] }, { args: ['frobnicate', '--help'] }, { args: ['frobnicate', '--zzz'] }])('unknown verb: hippo $args', async ({ args }) => {
    const res = await run(args);
    expect([res.ran, res.written]).toEqual([[], []]);
    expect(pinned(res)).toMatchSnapshot();
  });

  it('hippo --version prints the package version', async () => {
    // SAFETY: package.json always carries a string version.
    const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(pick(await run(['--version']))).toEqual({ status: 0, stdout: `${version}\n`, stderr: '' });
  });
});

describe('built CLI', () => {
  it('bin/hippo.js --help prints the same full usage and writes nothing', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      cwd: dirs.cwd,
      env: { ...ENV, HOME: dirs.home, USERPROFILE: dirs.home, HIPPO_HOME: dirs.store, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect({ status: res.status, stdout: res.stdout, stderr: ownStderr(res.stderr) }).toEqual(full);
    expect(written()).toEqual([]);
  });
});

describe('usage blocks', () => {
  it('every verb but the internal __ workers has its own block', () => {
    expect(VERBS.filter((verb) => !verb.startsWith('__') && verbUsage(verb) === null)).toEqual([]);
  });

  it('a block holds only its verb, and an alias prints its verb block', () => {
    expect(verbUsage('init')).toMatch(/^ {2}init .*\n {4}--scan/);
    expect(verbUsage('init')).not.toContain('remember');
    expect(verbUsage('project-brief')).toBe(verbUsage('brief'));
    expect(verbUsage('customer-note')).toBe(verbUsage('note'));
  });
});

describe('parseArgs: -h', () => {
  const argv = (...rest: string[]) => ['node', 'hippo', ...rest];

  it('a bare -h after the verb is the help flag', () => {
    const { flags, args } = parseArgs(argv('init', '-h'));
    expect(flags['help']).toBe(true);
    expect(args).toEqual([]);
  });

  it('-h after -- or as a flag value stays literal', () => {
    const passthrough = parseArgs(argv('codex-run', '--', '-h'));
    expect(passthrough.args).toEqual(['-h']);
    expect(passthrough.flags).toEqual({});
    expect(parseArgs(argv('remember', 'x', '--tag', '-h')).flags['tag']).toEqual(['-h']);
  });
});
