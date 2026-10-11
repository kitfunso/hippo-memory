// Pins stdout, stderr and exit code of every brief, note, policy, process and skill verb, run through runCli on a
// real store, so one shared handler set cannot change a byte unseen. Memory ids and timestamps are masked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { initStore } from '../src/store/open.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess, type InProcessResult } from './_helpers/run-in-process.js';

interface KindRow {
  readonly cmd: string;
  readonly create: readonly string[];
  readonly bare: readonly string[];
  readonly body: readonly string[];
  readonly bodyless: readonly string[];
}

const KINDS: readonly KindRow[] = [
  {
    cmd: 'brief', create: ['new', 'acme/web', '--summary', 'Storefront app'], bare: ['acme/api', '--summary', 'Orders service'],
    body: ['--summary', 'Storefront and admin app'], bodyless: ['new', 'acme/ops'],
  },
  {
    cmd: 'note', create: ['new', 'Acme Ltd', '--text', 'Prefers email'], bare: ['Globex', '--text', 'Pays monthly'],
    body: ['--text', 'Prefers a call'], bodyless: ['new', 'Initech'],
  },
  {
    cmd: 'policy', create: ['new', 'Retention', '--text', 'Delete logs after 90 days', '--from', '2026-01-01T00:00:00.000Z', '--to', '2027-01-01T00:00:00.000Z'],
    bare: ['Access', '--text', 'Two reviewers'], body: ['--text', 'Delete logs after 30 days', '--from', '2026-02-01T00:00:00.000Z'], bodyless: ['new', 'Backups'],
  },
  {
    cmd: 'process', create: ['new', 'Release', '--step', 'run the tests', '--step', 'publish', '--description', 'ship it'],
    bare: ['Deploy', '--step', 'push'], body: ['--step', 'sign the build', '--description', 'signed'], bodyless: ['new', 'Onboard'],
  },
  {
    cmd: 'skill', create: ['new', 'Review', '--instructions', 'Check the down path', '--trigger', 'on PR'],
    bare: ['Triage', '--instructions', 'Sort by impact'], body: ['--instructions', 'Check both paths', '--trigger', 'on merge'], bodyless: ['new', 'Plan'],
  },
];

const mask = (text: string): string => text
  .replace(/\b[a-z]{3}_[0-9a-f]{12}\b/g, '<mem>')
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');

const savedCwd = process.cwd();
let root = '';

beforeEach(() => {
  root = makeRoot('versioned-cli');
  // The CLI looks for the store in `.hippo` under the working directory.
  initStore(join(root, '.hippo'));
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(root);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const hippo = (...args: string[]): Promise<InProcessResult> => runInProcess(() => runCli(['node', 'hippo', ...args]));

describe('versioned object CLI verbs', () => {
  it.each(KINDS)('hippo $cmd: every subcommand prints the same bytes and exit code', async (k) => {
    const transcript: string[] = [];
    const step = async (...args: string[]): Promise<void> => {
      const r = await hippo(k.cmd, ...args);
      transcript.push(`$ ${k.cmd} ${args.join(' ')} -> ${r.status}\n--- stdout\n${mask(r.stdout)}--- stderr\n${mask(r.stderr)}`);
    };
    await step('list');
    await step('new');
    await step(...k.create);
    await step(...k.bare);
    await step('supersede');
    await step('supersede', '1');
    await step('supersede', '9999', ...k.body);
    await step('supersede', '1', ...k.body, '--change', 'tightened');
    await step('supersede', '1', ...k.body);
    await step('list');
    await step('list', '--status', 'superseded');
    await step('get', '3');
    await step('get', '9999');
    await step('close', '3');
    await step(...k.bodyless);
    expect(transcript.join('\n')).toMatchSnapshot();
  });

  it.each([
    ['new', 'Broken', '--step', '   '],
    ['supersede', '1', '--step', '   '],
  ])('a failing process save (%s) exits 1 and prints the store error alone', async (...args) => {
    expect((await hippo('process', 'new', 'Release', '--step', 'run the tests')).status).toBe(0);
    expect(await hippo('process', ...args)).toEqual({ stdout: '', stderr: 'saveProcess: step 1 is empty\n', status: 1 });
  });
});
