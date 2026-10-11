// Pins the exact stdout, stderr and exit code of every help and unknown-verb form, and that --help runs no verb.
// In-process, since a spawn per form cost about a minute of CI time; one spawned run keeps the built binary in the loop.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, runCli, usageText, verbUsage } from '../src/cli.js';
import type { VerbFlags } from '../src/cli/flags.js';
import { COMMANDS } from '../src/cli/verbs.js';
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

interface CommandRow { readonly flags: VerbFlags }
// Pinned rather than read from the rows, so a row that gains or loses --dry-run fails here first.
const DRY_RUN_VERBS = ['audit', 'capture', 'dedup', 'forget', 'import', 'invalidate', 'refine', 'setup', 'sleep'];
// Declared flags the help does not name yet: document one, then delete it here; the list may only shrink.
const UNDOCUMENTED = new Map(Object.entries({
  remember: ['artifact-ref', 'extract', 'force', 'kind', 'layer', 'owner', 'scope'],
  recall: ['classic', 'equal-sources', 'layer', 'limit', 'local-bump', 'outcome', 'physics', 'scope'],
  drill: ['depth'],
  explain: ['as-of', 'equal-sources', 'include-superseded', 'local-bump', 'scope'],
  eval: ['baseline', 'save-baseline', 'suite'],
  trace: ['outcome', 'session', 'source', 'steps', 'tag', 'task'],
  sleep: ['log-file'],
  'session-end': ['dry-run', 'format', 'no-learn', 'no-share', 'session-id', 'transcript'],
  'pre-compact': ['format'],
  'capture-error': ['format'],
  snapshot: ['id'],
  session: ['outcome', 'session', 'summary'],
  handoff: ['id'],
  forget: ['dry-run'],
  context: ['cross-project', 'limit', 'runtime', 'scope'],
  embed: ['global', 'reset-physics'],
  sync: ['cross-project'],
  peers: ['all-tenants'],
  graph: ['entity', 'format', 'json', 'open', 'out'],
}));
const namesOf = (flags: VerbFlags): string[] =>
  [...(flags.switches ?? []), ...(flags.values ?? []), ...(flags.numbers ?? []), ...(flags.lists ?? [])];
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

  it('every verb row names a handle<Verb> export and never a cmd<Name>', () => {
    // Read from source: the spies above replaced each run function.
    const dir = resolve(__dirname, '..', 'src', 'cli', 'verbs');
    const rowCall = /\bverb\(\(\) => import\('[^']+'\), '(\w+)'/g;
    const names = readdirSync(dir).flatMap((file) => [...readFileSync(join(dir, file), 'utf8').matchAll(rowCall)].map((m) => m[1]));
    expect(names).toHaveLength(Object.keys(COMMANDS).length);
    expect(names.filter((name) => !/^handle[A-Z]/.test(name))).toEqual([]);
  });

  it.for(VERBS)('hippo %s --dry-run runs the verb only where its row honours the flag', async (verb) => {
    const res = await run([verb, '--dry-run']);
    expect([res.ran, res.written]).toEqual([DRY_RUN_VERBS.includes(verb) ? [verb] : [], []]);
    if (res.ran.length === 0) expect([res.status, res.stderr]).toEqual([2, expect.stringContaining(`hippo ${verb} has no --dry-run`)]);
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

  it.for(Object.entries<CommandRow>(COMMANDS).filter(([verb]) => !verb.startsWith('__')))('%s help names every flag the verb declares and no other', async ([verb, spec]) => {
    const subHelp: string[] = [];
    // One at a time: each run captures the process's stdout.
    for (const sub of SUBCOMMANDS.filter(([own]) => own === verb)) subHelp.push((await run([...sub, '--help'])).stdout);
    const named = new Set([...[verbUsage(verb), ...subHelp].join('\n').matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
    const declared = namesOf(spec.flags);
    expect({ missing: declared.filter((name) => !named.has(name)).sort(), undeclared: [...named].filter((name) => !declared.includes(name)) })
      .toEqual({ missing: UNDOCUMENTED.get(verb) ?? [], undeclared: [] });
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
