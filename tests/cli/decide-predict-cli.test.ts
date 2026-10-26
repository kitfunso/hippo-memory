/** `hippo decide` and `hippo predict` through runCli: each record's full life on a real store, and the refusals. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { readEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const savedCwd = process.cwd();
let cwd: string;
beforeEach(() => {
  cwd = makeRoot('decide-predict', { init: false });
  mkdirSync(join(cwd, 'global-hippo'));
  initTestStore(join(cwd, '.hippo'));
  vi.stubEnv('HIPPO_HOME', join(cwd, 'global-hippo'));
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  // The CLI looks for the store in `.hippo` under the working directory.
  process.chdir(cwd);
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
});

const hippo = (...args: string[]): Promise<InProcessResult> => runInProcess(() => runCli(['node', 'hippo', ...args]));

async function ok(...args: string[]): Promise<string> {
  const r = await hippo(...args);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const grab = (text: string, re: RegExp): string => {
  const m = re.exec(text);
  expect(m, `${re} in ${text}`).not.toBeNull();
  return m![1];
};

describe('hippo decide', () => {
  it('records, supersedes by memory id, closes and lists a decision', async () => {
    const first = await ok('decide', 'use sqlite for the local store', '--context', 'no server to run');
    const firstId = grab(first, /Decision recorded: #(\d+)/);
    const firstMem = grab(first, /memory: (\S+)/);
    expect(await ok('decide', 'get', firstId)).toMatch(
      /status: active[\s\S]*text: use sqlite[\s\S]*context: no server to run/,
    );

    const second = await ok('decide', 'use postgres for the shared store', '--supersedes', firstMem);
    const secondId = grab(second, /Decision recorded: #(\d+)/);
    expect(second).toContain(`supersedes memory: ${firstMem} (decision #${firstId} superseded)`);
    expect(await ok('decide', 'get', firstId)).toContain(`superseded_by: #${secondId}`);
    const weakened = readEntry(join(cwd, '.hippo'), firstMem, 'default');
    expect(weakened?.confidence).toBe('stale');
    expect(weakened?.tags).toContain('superseded');

    expect(await ok('decide', 'close', secondId)).toContain(`Decision #${secondId} closed.`);
    const closed = await ok('decide', 'list', '--status', 'closed');
    expect(closed).toContain('Found 1 decisions');
    expect(closed).toContain(`#${secondId} [closed]`);
    expect(await ok('decide', 'list')).toContain('Found 2 decisions');
  });

  it('refuses a valueless --supersedes, an unknown memory, an unknown id and a bad status', async () => {
    expect((await hippo('decide', 'pick one', '--supersedes')).stderr).toContain('--supersedes requires a memory id');
    const unknownMem = await hippo('decide', 'pick one', '--supersedes', 'mem_nope');
    expect([unknownMem.status, unknownMem.stderr]).toEqual([1, expect.stringContaining('Memory mem_nope not found.')]);
    expect((await hippo('decide', 'get', '999')).stderr).toContain('Decision 999 not found.');
    expect((await hippo('decide', 'get', 'abc')).stderr).toContain('Invalid decision id');
    const status = await hippo('decide', 'list', '--status', 'pending');
    expect([status.status, status.stderr]).toEqual([1, expect.stringContaining('Invalid --status: "pending"')]);
    expect(await ok('decide', 'list')).toContain('No decisions.');
  });
});

describe('hippo predict', () => {
  it('records, shows, closes and scores a prediction against its class', async () => {
    const made = await ok(
      'predict',
      'the migration lands this sprint',
      '--class',
      'migration',
      '--estimate',
      '5',
      '--unit',
      'days',
      '--target',
      '2026-11-01',
    );
    const id = grab(made, /Prediction recorded: #(\d+) class=migration/);
    expect(await ok('predict', 'list', '--status', 'open')).toContain(
      `#${id} [open] class=migration estimate=5 days target=2026-11-01`,
    );
    expect(await ok('predict', 'baserate', '--class', 'migration')).toContain(
      'No closed predictions in class "migration" yet.',
    );

    expect(
      await ok('predict', 'close', id, '--state', 'closed', '--actual', '8', '--note', 'schema review slipped'),
    ).toContain(`Prediction ${id} closed: state=closed actual=8`);
    expect(await ok('predict', 'show', id)).toMatch(
      /state: closed[\s\S]*estimate: 5 days[\s\S]*actual: 8[\s\S]*note: schema review slipped/,
    );
    const closed = await ok('predict', 'list', '--status', 'closed', '--class', 'migration');
    expect(closed).toContain(`#${id} [closed] class=migration estimate=5 days actual=8`);
    expect(closed).toContain('note: schema review slipped');

    const rate = await ok('predict', 'baserate', '--class', 'migration');
    expect(rate).toContain('n_closed:         1');
    expect(rate).toContain('mean_ratio:       1.600x');
  });

  it('list with no --status and no --class shows closed predictions in every class', async () => {
    const openId = grab(
      await ok('predict', 'the cache warms in an hour', '--class', 'ops'),
      /Prediction recorded: #(\d+)/,
    );
    const closedId = grab(
      await ok('predict', 'the port lands in a week', '--class', 'port', '--estimate', '7'),
      /Prediction recorded: #(\d+)/,
    );
    await ok('predict', 'close', closedId, '--state', 'closed', '--actual', '9');
    const all = await ok('predict', 'list');
    expect(all).toContain('Found 2 predictions');
    expect(all).toContain(`#${openId} [open] class=ops`);
    expect(all).toContain(`#${closedId} [closed] class=port`);
  });

  it.each([
    ['decide', 'get', '12abc'],
    ['decide', 'close', '0x1'],
    ['predict', 'show', '12abc'],
    ['predict', 'close', '0x1'],
  ])(
    'refuses the partly numeric id in `%s %s %s` that the lenient parser used to read as a number',
    async (verb, sub, id) => {
      const r = await hippo(verb, sub, id, ...(sub === 'close' && verb === 'predict' ? ['--state', 'closed'] : []));
      expect([r.status, r.stderr]).toEqual([1, expect.stringContaining('expected a positive integer')]);
    },
  );

  it('refuses a missing class, bad numbers, a bad state and a closed filter without a class', async () => {
    expect((await hippo('predict', 'a claim')).stderr).toContain('--class is required');
    expect((await hippo('predict', 'a claim', '--class', 'c', '--estimate', 'soon')).stderr).toContain(
      'Invalid --estimate: "soon"',
    );
    expect((await hippo('predict', 'close', '1', '--state', 'open')).stderr).toContain('Invalid --state: "open"');
    expect((await hippo('predict', 'close', '1', '--state', 'closed', '--actual', 'x')).stderr).toContain(
      'Invalid --actual: "x"',
    );
    expect((await hippo('predict', 'close', 'zero', '--state', 'closed')).stderr).toContain('Invalid prediction id');
    expect((await hippo('predict', 'list', '--status', 'closed')).stderr).toContain('requires --class');
    expect((await hippo('predict', 'list', '--status', 'later')).stderr).toContain('Invalid --status: "later"');
    expect((await hippo('predict', 'list', '--limit', '0')).stderr).toContain('Invalid --limit');
    expect((await hippo('predict', 'show', '42')).stderr).toContain('Prediction 42 not found.');
    const usage = await hippo('predict');
    expect([usage.status, usage.stderr]).toEqual([1, expect.stringContaining('Usage: hippo predict')]);
  });
});
