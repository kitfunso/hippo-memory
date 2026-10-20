// The `hippo note|incident|policy|process|brief|skill` verbs, run in process through runCli on a real store. The codex
// P2 regressions (a create keyword stored as the name, a lenient parseInt on a mutating verb) run once per noun.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { makeEnv, type TestEnv } from '../_helpers/cli-env.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

interface Noun {
  readonly noun: string;
  /** A create that names its subcommand, which must not be stored as the name. */
  readonly create: readonly string[];
  readonly recorded: RegExp;
  readonly listed: string;
  readonly notListed?: RegExp;
  /** What `get` prints for the row `create` made. */
  readonly shown: readonly string[];
  readonly states: string;
  readonly live: string;
  readonly keep: readonly string[];
  readonly kept: string;
  /** Flags of a valid supersede; incidents have no supersede verb. */
  readonly revise?: readonly string[];
}

const NOUNS: readonly Noun[] = [
  {
    noun: 'note',
    create: ['new', 'Acme Corp', '--text', 'renewal call notes'],
    recorded: /Customer note recorded: #\d+/,
    listed: 'customer="Acme Corp"',
    notListed: /customer="new"/,
    shown: ['renewal call notes', 'customer: Acme Corp'],
    states: 'active | superseded | closed',
    live: 'active',
    keep: ['new', 'still-active', '--text', 'x'],
    kept: 'still-active',
    revise: ['--text', 'y'],
  },
  {
    noun: 'incident',
    create: ['open', 'DB down at 14:00'],
    recorded: /Incident recorded: #\d+/,
    listed: 'DB down at 14:00',
    shown: ['DB down at 14:00'],
    states: 'open | resolved | closed',
    live: 'open',
    keep: ['open', 'still open incident'],
    kept: 'still open incident',
  },
  {
    noun: 'policy',
    create: ['new', 'Retention policy', '--text', 'delete after 90d', '--from', '2026-01-01'],
    recorded: /Policy recorded: #\d+/,
    listed: 'Retention policy',
    shown: ['delete after 90d', 'valid_from: 2026-01-01T00:00:00.000Z'],
    states: 'active | superseded | closed',
    live: 'active',
    keep: ['new', 'still active', '--text', 'x'],
    kept: 'still active',
    revise: ['--text', 'y'],
  },
  {
    noun: 'process',
    create: ['new', 'Release flow', '--step', 'run tests', '--step', 'publish'],
    recorded: /Process recorded: #\d+/,
    listed: 'Release flow',
    notListed: /^\s+new$/m,
    shown: ['1. run tests', '2. publish'],
    states: 'active | superseded | closed',
    live: 'active',
    keep: ['new', 'still active process', '--step', 'a'],
    kept: 'still active process',
    revise: ['--step', 'x'],
  },
  {
    noun: 'brief',
    create: ['new', 'hippo', '--summary', 'agent memory lib'],
    recorded: /Project brief recorded: #\d+/,
    listed: 'repo="hippo"',
    notListed: /repo="new"/,
    shown: ['agent memory lib', 'repo: hippo'],
    states: 'active | superseded | closed',
    live: 'active',
    keep: ['new', 'still-active', '--summary', 'x'],
    kept: 'still-active',
    revise: ['--summary', 'y'],
  },
  {
    noun: 'skill',
    create: ['new', 'Run tests', '--instructions', 'npm test', '--trigger', 'before commit'],
    recorded: /Skill recorded: #\d+/,
    listed: 'Run tests',
    shown: ['npm test', 'when: before commit'],
    states: 'active | superseded | closed',
    live: 'active',
    keep: ['new', 'still active', '--instructions', 'x'],
    kept: 'still active',
    revise: ['--instructions', 'y'],
  },
];

const savedCwd = process.cwd();
let env: TestEnv;

beforeEach(() => {
  env = makeEnv('typed-object-cli');
  vi.stubEnv('HIPPO_HOME', env.globalRoot);
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SESSION_ID', 's-cli-objects');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  // The CLI looks for the store in `.hippo` under the working directory.
  process.chdir(env.cwd);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  removeAfterRequest(env.cwd);
});

const hippo = (...args: string[]): Promise<InProcessResult> => runInProcess(() => runCli(['node', 'hippo', ...args]));

/** Stdout of a verb that must succeed. */
async function ok(...args: string[]): Promise<string> {
  const res = await hippo(...args);
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

function idOf(output: string): string {
  const id = /#(\d+)/.exec(output)?.[1];
  if (id === undefined) throw new Error(`no "#<id>" found in CLI output: ${output}`);
  return id;
}

describe.each(NOUNS)('hippo $noun CLI', (k) => {
  it('a create that names its subcommand records the real name, not the keyword', async () => {
    const created = await ok(k.noun, ...k.create);
    expect(created).toMatch(k.recorded);
    const list = await ok(k.noun, 'list');
    expect(list).toContain(k.listed);
    if (k.notListed) expect(list).not.toMatch(k.notListed);
    const shown = await ok(k.noun, 'get', idOf(created));
    for (const text of k.shown) expect(shown).toContain(text);
  });

  it('list rejects an unknown --status and names the allowed values', async () => {
    const res = await hippo(k.noun, 'list', '--status', 'bogus');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`Invalid --status: "bogus". Must be one of: ${k.states} | all.`);
  });

  it('rejects a malformed id and does NOT mutate the wrong row', async () => {
    await ok(k.noun, ...k.keep);
    // parseInt("1abc") is 1, so a lenient parse would act on row 1.
    expect((await hippo(k.noun, 'close', '1abc')).status).toBe(1);
    if (k.revise) expect((await hippo(k.noun, 'supersede', '1abc', ...k.revise)).status).toBe(1);
    expect(await ok(k.noun, 'list', '--status', k.live)).toContain(k.kept);
  });
});

describe('typed-object CLI rules one noun has', () => {
  it('bare `incident "<text>"` records the text', async () => {
    await ok('incident', 'bare form incident');
    expect(await ok('incident', 'list')).toContain('bare form incident');
  });

  it('incident open -> resolve -> close lifecycle', async () => {
    const id = idOf(await ok('incident', 'open', 'disk full on host-3'));
    await ok('incident', 'resolve', id, '--resolution', 'freed 20GB, rotated logs');
    expect(await ok('incident', 'list', '--status', 'resolved')).toContain('disk full on host-3');
    await ok('incident', 'close', id);
    expect(await ok('incident', 'list', '--status', 'closed')).toContain('disk full on host-3');
  });

  it('many notes per customer + new->supersede version chain', async () => {
    await ok('note', 'new', 'Acme', '--text', 'note one');
    const id = idOf(await ok('note', 'new', 'Acme', '--text', 'note two'));
    // Both stay active for the same customer; the list row shows customer=, not the body.
    const active = await ok('note', 'list', '--customer', 'Acme', '--status', 'active');
    expect((active.match(/customer="Acme"/g) ?? []).length).toBe(2);
    expect(await ok('note', 'supersede', id, '--text', 'note two v2', '--change', 'corrected')).toMatch(/v2/);
  });

  it('policy new -> supersede version chain + asof query', async () => {
    const id = idOf(await ok('policy', 'new', 'Window', '--text', 'v1', '--from', '2026-01-01', '--to', '2026-06-01'));
    const sup = await ok(
      'policy',
      'supersede',
      id,
      '--text',
      'v2',
      '--from',
      '2026-01-01',
      '--to',
      '2026-06-01',
      '--change',
      'reworded',
    );
    expect(sup).toMatch(/v2/);
    const asof = await ok('policy', 'asof', '2026-03-01', '--name', 'Window');
    expect(asof).toContain('Window');
    expect(asof).toContain('v2');
    // valid_to is exclusive, so its own instant is out of force.
    expect(await ok('policy', 'asof', '2026-06-01', '--name', 'Window')).toContain('No active policies in force');
  });

  it('policy new rejects an inverted valid_to', async () => {
    expect(
      (await hippo('policy', 'new', 'Inv', '--text', 'x', '--from', '2026-06-01', '--to', '2026-01-01')).status,
    ).toBe(1);
  });

  it('process new -> supersede -> list version chain', async () => {
    const id = idOf(await ok('process', 'new', 'Deploy', '--step', 'a'));
    expect(await ok('process', 'supersede', id, '--step', 'a', '--step', 'b', '--change', 'added b')).toMatch(/v2/);
    expect(await ok('process', 'list', '--status', 'active')).toContain('v2');
    expect(await ok('process', 'list', '--status', 'superseded')).toContain('Deploy');
  });

  it('brief new -> supersede version chain, listed by repo', async () => {
    const id = idOf(await ok('brief', 'new', 'r', '--summary', 'v1 body'));
    expect(await ok('brief', 'supersede', id, '--summary', 'v2 body', '--change', 'updated')).toMatch(/v2/);
    expect(await ok('brief', 'list', '--status', 'active', '--repo', 'r')).toContain('v2');
  });

  it('brief refresh writes a v1 brief; --dry-run prints the digest without writing', async () => {
    // Receipt path-tag matching is covered in the store test; this checks the CLI write and dry-run paths.
    expect(await ok('brief', 'refresh', 'demo-repo', '--dry-run')).toContain('# Project Brief: demo-repo');
    expect(await ok('brief', 'list')).toContain('No project briefs.');
    expect(await ok('brief', 'refresh', 'demo-repo')).toMatch(/Project brief #\d+ recorded \(v1\)/);
    expect(await ok('brief', 'list')).toContain('repo="demo-repo"');
  });

  it('skill new -> supersede version chain + export renders the active version only', async () => {
    const id = idOf(await ok('skill', 'new', 'Lint', '--instructions', 'eslint v1'));
    expect(await ok('skill', 'supersede', id, '--instructions', 'eslint v2', '--change', 'updated')).toMatch(/v2/);
    const md = await ok('skill', 'export');
    expect(md).toContain('## Lint');
    expect(md).toContain('eslint v2');
    expect(md).not.toContain('eslint v1');
  });

  it('skill export on an empty store prints a friendly message', async () => {
    expect(await ok('skill', 'export')).toContain('No active skills');
  });
});
