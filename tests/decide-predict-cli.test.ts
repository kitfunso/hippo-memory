/** `hippo decide` and `hippo predict` through the built CLI: each record's full life on a real store, and the refusals. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { readEntry } from '../src/store/entry-reads.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'hippo-decide-predict-'));
  mkdirSync(join(cwd, 'global-hippo'));
  initStore(join(cwd, '.hippo'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function hippo(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HIPPO_HOME: join(cwd, 'global-hippo'), HIPPO_TENANT: 'default', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ok(...args: string[]): string {
  const r = hippo(...args);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const grab = (text: string, re: RegExp): string => {
  const m = re.exec(text);
  expect(m, `${re} in ${text}`).not.toBeNull();
  return m![1];
};

describe('hippo decide', () => {
  it('records, supersedes by memory id, closes and lists a decision', () => {
    const first = ok('decide', 'use sqlite for the local store', '--context', 'no server to run');
    const firstId = grab(first, /Decision recorded: #(\d+)/);
    const firstMem = grab(first, /memory: (\S+)/);
    expect(ok('decide', 'get', firstId)).toMatch(/status: active[\s\S]*text: use sqlite[\s\S]*context: no server to run/);

    const second = ok('decide', 'use postgres for the shared store', '--supersedes', firstMem);
    const secondId = grab(second, /Decision recorded: #(\d+)/);
    expect(second).toContain(`supersedes memory: ${firstMem} (decision #${firstId} superseded)`);
    expect(ok('decide', 'get', firstId)).toContain(`superseded_by: #${secondId}`);
    const weakened = readEntry(join(cwd, '.hippo'), firstMem, 'default');
    expect(weakened?.confidence).toBe('stale');
    expect(weakened?.tags).toContain('superseded');

    expect(ok('decide', 'close', secondId)).toContain(`Decision #${secondId} closed.`);
    const closed = ok('decide', 'list', '--status', 'closed');
    expect(closed).toContain('Found 1 decisions');
    expect(closed).toContain(`#${secondId} [closed]`);
    expect(ok('decide', 'list')).toContain('Found 2 decisions');
  });

  it('refuses a valueless --supersedes, an unknown memory, an unknown id and a bad status', () => {
    expect(hippo('decide', 'pick one', '--supersedes').stderr).toContain('--supersedes requires a memory id');
    const unknownMem = hippo('decide', 'pick one', '--supersedes', 'mem_nope');
    expect([unknownMem.status, unknownMem.stderr]).toEqual([1, expect.stringContaining('Memory mem_nope not found.')]);
    expect(hippo('decide', 'get', '999').stderr).toContain('Decision 999 not found.');
    expect(hippo('decide', 'get', 'abc').stderr).toContain('Invalid decision id');
    const status = hippo('decide', 'list', '--status', 'pending');
    expect([status.status, status.stderr]).toEqual([1, expect.stringContaining('Invalid --status: "pending"')]);
    expect(ok('decide', 'list')).toContain('No decisions.');
  });
});

describe('hippo predict', () => {
  it('records, shows, closes and scores a prediction against its class', () => {
    const made = ok('predict', 'the migration lands this sprint', '--class', 'migration', '--estimate', '5', '--unit', 'days', '--target', '2026-11-01');
    const id = grab(made, /Prediction recorded: #(\d+) class=migration/);
    expect(ok('predict', 'list', '--status', 'open')).toContain(`#${id} [open] class=migration estimate=5 days target=2026-11-01`);
    expect(ok('predict', 'baserate', '--class', 'migration')).toContain('No closed predictions in class "migration" yet.');

    expect(ok('predict', 'close', id, '--state', 'closed', '--actual', '8', '--note', 'schema review slipped'))
      .toContain(`Prediction ${id} closed: state=closed actual=8`);
    expect(ok('predict', 'show', id)).toMatch(/state: closed[\s\S]*estimate: 5 days[\s\S]*actual: 8[\s\S]*note: schema review slipped/);
    const closed = ok('predict', 'list', '--status', 'closed', '--class', 'migration');
    expect(closed).toContain(`#${id} [closed] class=migration estimate=5 days actual=8`);
    expect(closed).toContain('note: schema review slipped');

    const rate = ok('predict', 'baserate', '--class', 'migration');
    expect(rate).toContain('n_closed:         1');
    expect(rate).toContain('mean_ratio:       1.600x');
  });

  it('refuses a missing class, bad numbers, a bad state and a closed filter without a class', () => {
    expect(hippo('predict', 'a claim').stderr).toContain('--class is required');
    expect(hippo('predict', 'a claim', '--class', 'c', '--estimate', 'soon').stderr).toContain('Invalid --estimate: "soon"');
    expect(hippo('predict', 'close', '1', '--state', 'open').stderr).toContain('Invalid --state: "open"');
    expect(hippo('predict', 'close', '1', '--state', 'closed', '--actual', 'x').stderr).toContain('Invalid --actual: "x"');
    expect(hippo('predict', 'close', 'zero', '--state', 'closed').stderr).toContain('Invalid prediction id');
    expect(hippo('predict', 'list', '--status', 'closed').stderr).toContain('requires --class');
    expect(hippo('predict', 'list', '--status', 'later').stderr).toContain('Invalid --status: "later"');
    expect(hippo('predict', 'list', '--limit', '0').stderr).toContain('Invalid --limit');
    expect(hippo('predict', 'show', '42').stderr).toContain('Prediction 42 not found.');
    const usage = hippo('predict');
    expect([usage.status, usage.stderr]).toEqual([1, expect.stringContaining('Usage: hippo predict')]);
  });
});
