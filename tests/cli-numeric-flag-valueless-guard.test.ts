/**
 * A value-less numeric flag parses to NaN, which survives every downstream comparison; mirrors cli-scope-valueless-guard.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

type GuardEnv = {
  HIPPO_HOME: string;
  HIPPO_SKIP_AUTO_INTEGRATIONS: string;
};

// Strips keys that could turn a guard regression into a real network/paid-API
// call (Jev reranker, refine's Anthropic key) before every spawned child.
function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.TYPESAFE_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.HIPPO_TENANT;
  return env;
}

function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], {
    cwd,
    env: childEnv(env),
    encoding: 'utf-8',
  });
}

function hippoRun(cwd: string, env: Record<string, string>, ...args: string[]) {
  // A reverted guard lets `serve --port` bind and hang forever, and spawnSync blocks
  // the worker's event loop, so vitest's own testTimeout could never fire on it.
  const res = spawnSync('node', [HIPPO_BIN, ...args], {
    cwd,
    env: childEnv(env),
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('global numeric-flag value-less/non-numeric guard - exit-1 cases', () => {
  let home: string;
  let env: GuardEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-numeric-guard-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // One case per filed flag, driven on a command that owns it, so a
  // regression cannot pass by accident of dispatch order.
  const cases: Array<{ flag: string; args: string[] }> = [
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
  ];

  for (const c of cases) {
    it(`${c.args[0]} --${c.flag}: value-less exits 1 with a numeric-value message`, () => {
      const res = hippoRun(home, env, ...c.args);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`--${c.flag} requires a numeric value`);
    });
  }

  // Pins the GLOBAL semantics: cmdStatus takes no flags at all (mirrors the
  // --scope test's status case), yet the guard still exits 1 pre-dispatch.
  it('status (a command that reads none of the twelve): value-less --limit still exits 1', () => {
    const res = hippoRun(home, env, 'status', '--limit');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--limit requires a numeric value');
  });
});

describe('refine --limit: the paid-API-runaway pin', () => {
  let home: string;
  let env: GuardEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-numeric-guard-refine-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // The guard sits before cmdRefine's own ANTHROPIC_API_KEY check, so a
  // value-less --limit must never reach it and must make no API call.
  it('value-less --limit exits 1 before the ANTHROPIC_API_KEY check', () => {
    const res = hippoRun(home, env, 'refine', '--limit');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--limit requires a numeric value');
    expect(res.stderr).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('dedup --threshold: the no-undo data-loss pin', () => {
  let home: string;
  let env: GuardEnv;
  // Deliberately NOT near-duplicates: dedupe.ts only deletes a pair whose
  // similarity exceeds the threshold, so a NaN threshold is the only way in.
  const CONTENT_A = 'The quarterly budget review meeting moved to Thursday afternoon.';
  const CONTENT_B = 'Bananas are a good source of potassium and dietary fiber.';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-numeric-guard-dedup-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    hippo(home, env, 'remember', CONTENT_A);
    hippo(home, env, 'remember', CONTENT_B);
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
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

  it('value-less --threshold exits 1 and deletes nothing', () => {
    expect(memoryCount()).toBe(2);
    const res = hippoRun(home, env, 'dedup', '--threshold');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--threshold requires a numeric value');
    expect(memoryCount()).toBe(2);
  });

  it('--threshold banana exits 1 and deletes nothing', () => {
    expect(memoryCount()).toBe(2);
    const res = hippoRun(home, env, 'dedup', '--threshold', 'banana');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--threshold requires a numeric value');
    expect(memoryCount()).toBe(2);
  });
});

describe('serve --port: the silent-wrong-port pin', () => {
  let home: string;
  let env: GuardEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-numeric-guard-serve-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // Without the guard this binds port 1 and runs forever; spawnSync
  // returning at all (with exit 1) is itself proof nothing started listening.
  it('value-less --port exits 1 instead of silently binding port 1', () => {
    const res = hippoRun(home, env, 'serve', '--port');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--port requires a numeric value');
  });
});

describe('valued numeric flags: the guard must not regress a legitimate call', () => {
  let home: string;
  let env: GuardEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-numeric-guard-valued-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // Already-guarded shape: --hops rejects a boolean on its own (cli.ts:1199)
  // and is the precedent this guard generalises; it must still work.
  it('recall --hops 1 (already-guarded site): valid value runs normally', () => {
    const res = hippoRun(home, env, 'recall', 'some query', '--hops', '1');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No memories found for: some query');
  });

  // Fails-closed shape: predict list's own --limit check (cli.ts:4888-4893).
  it('predict list --limit 5 (fails-closed site): valid value runs normally', () => {
    const res = hippoRun(home, env, 'predict', 'list', '--limit', '5');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No predictions.');
  });

  // Silent-wrong-value shape, plus the negative-number spelling the widened
  // predicate must still accept.
  it('recall --local-bump -1 (silent-wrong-value site): valid negative value runs normally', () => {
    const res = hippoRun(home, env, 'recall', 'some query', '--local-bump', '-1');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No memories found for: some query');
  });

  // Decimal and exponential-notation spellings the widened predicate must
  // still accept (Number.isFinite(Number(raw)) is true for both).
  it('share --auto --min-score 0.6 --dry-run: decimal value runs normally', () => {
    const res = hippoRun(home, env, 'share', '--auto', '--min-score', '0.6', '--dry-run');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No memories meet the sharing threshold.');
  });

  it('recall --limit 1e3: exponential-notation value runs normally', () => {
    const res = hippoRun(home, env, 'recall', 'some query', '--limit', '1e3');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No memories found for: some query');
  });
});
