/**
 * A value-less numeric flag parses to NaN, which survives every downstream comparison; mirrors cli-scope-valueless-guard.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { runCli as runCliEntry } from '../../src/cli.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const savedCwd = process.cwd();
let home = '';

// The guard sits in main() before any verb, so the whole entry runs in process; no process boundary is under test.
const hippoRun = (...args: string[]): Promise<InProcessResult> =>
  runInProcess(() => runCliEntry(['node', 'hippo', ...args]));

beforeEach(() => {
  home = makeStore('numeric-guard').base;
  vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  // Blank keys so a guard regression cannot turn into a real network or paid-API call (Jev reranker, refine).
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  removeAfterRequest(home);
});

describe('global numeric-flag value-less/non-numeric guard - exit-1 cases', () => {
  // One case per filed flag, driven on a command that owns it, so a
  // regression cannot pass by accident of dispatch order.
  it.each([
    { flag: 'days', args: ['learn', '--git', '--days'] },
    { flag: 'threshold', args: ['dedup', '--threshold'] },
    { flag: 'min-score', args: ['share', '--auto', '--min-score'] },
    { flag: 'port', args: ['dashboard', '--port'] },
    { flag: 'limit', args: ['refine', '--limit'] },
    { flag: 'mmr-lambda', args: ['recall', 'some query', '--mmr-lambda'] },
    { flag: 'local-bump', args: ['recall', 'some query', '--local-bump'] },
    { flag: 'min-results', args: ['recall', 'some query', '--min-results'] },
    { flag: 'reranker-top-k', args: ['recall', 'some query', '--reranker-top-k'] },
    { flag: 'min-mrr', args: ['eval', '--min-mrr'] },
    { flag: 'embedding-weight', args: ['eval', '--embedding-weight'] },
    { flag: 'max-cases', args: ['eval', '--max-cases'] },
  ])('$args.0 --$flag: value-less exits 1 with a numeric-value message', async ({ flag, args }) => {
    const res = await hippoRun(...args);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`--${flag} requires a numeric value`);
  });

  it.each(['0', '2.5'])(
    'recall --reranker-top-k %s exits 1, since a slice would quietly drop candidates',
    async (value) => {
      const res = await hippoRun('recall', 'some query', '--reranker', 'clef-flash', '--reranker-top-k', value);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Must be a positive integer');
    },
  );

  // Pins the GLOBAL semantics: handleStatus takes no flags at all (mirrors the
  // --scope test's status case), yet the guard still exits 1 pre-dispatch.
  it('status (a command that reads none of the twelve): value-less --limit still exits 1', async () => {
    const res = await hippoRun('status', '--limit');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--limit requires a numeric value');
  });
});

describe('refine --limit: the paid-API-runaway pin', () => {
  // The guard sits before handleRefine's own ANTHROPIC_API_KEY check, so a
  // value-less --limit must never reach it and must make no API call.
  it('value-less --limit exits 1 before the ANTHROPIC_API_KEY check', async () => {
    const res = await hippoRun('refine', '--limit');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--limit requires a numeric value');
    expect(res.stderr).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('dedup --threshold: the no-undo data-loss pin', () => {
  // Deliberately different texts: dedup removes only copies of the same text,
  // so a bad --threshold value must fail loud and delete nothing.
  const CONTENT_A = 'The quarterly budget review meeting moved to Thursday afternoon.';
  const CONTENT_B = 'Bananas are a good source of potassium and dietary fiber.';

  beforeEach(async () => {
    expect((await hippoRun('remember', CONTENT_A)).status).toBe(0);
    expect((await hippoRun('remember', CONTENT_B)).status).toBe(0);
  });

  // Counts the store directly; parsing CLI output would measure the message,
  // not the rows actually left behind.
  function memoryCount(): number {
    const db = openHippoDb(join(home, '.hippo'));
    try {
      // SAFETY: COUNT(*) AS n always yields exactly one row with a numeric n.
      const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      return row.n;
    } finally {
      closeHippoDb(db);
    }
  }

  it.each([[[]], [['banana']]])('--threshold %j exits 1 and deletes nothing', async (value: string[]) => {
    expect(memoryCount()).toBe(2);
    const res = await hippoRun('dedup', '--threshold', ...value);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--threshold requires a numeric value');
    expect(memoryCount()).toBe(2);
  });
});

describe('serve --port: the silent-wrong-port pin', () => {
  // Without the guard this binds port 1 and never settles, so the test times out instead of passing.
  it('value-less --port exits 1 instead of silently binding port 1', async () => {
    const res = await hippoRun('serve', '--port');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--port requires a numeric value');
  });
});

describe('valued numeric flags: the guard must not regress a legitimate call', () => {
  // --hops is the already-guarded precedent; --local-bump -1 is the negative spelling; 1e3 the exponential one.
  it.each([
    { args: ['recall', 'some query', '--hops', '1'], out: 'No memories found for: some query' },
    { args: ['predict', 'list', '--limit', '5'], out: 'No predictions.' },
    { args: ['recall', 'some query', '--local-bump', '-1'], out: 'No memories found for: some query' },
    { args: ['share', '--auto', '--min-score', '0.6', '--dry-run'], out: 'No memories meet the sharing threshold.' },
    { args: ['recall', 'some query', '--limit', '1e3'], out: 'No memories found for: some query' },
  ])('$args.0 $args.2 $args.3 runs normally', async ({ args, out }) => {
    const res = await hippoRun(...args);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(out);
  });
});
