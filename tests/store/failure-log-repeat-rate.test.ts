/** Failure log (ROADMAP CD13): every failed tool call is logged as hashes with its session; repeats across sessions count. */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { summarizeFailures } from '../../src/store/sqlite/failure-log.js';
import { failuresPerSession } from '../../src/base/records/failure-repeats.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { captureToolFailure } from '../../src/surface/capture/capture-error.js';
import { failureTarget } from '../_helpers/failure-target.js';
import { failureSignature, lessonFromFailure } from '../../src/surface/capture/failure-reading.js';
import { blockHash } from '../../src/base/util/token-text.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { RejectedValueError } from '../../src/base/errors/api-errors.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import type { FailureOutcome } from '../../src/store/port/failure-log.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

function withDb<T>(root: string, fn: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

interface LogRow {
  session_id: string | null;
  tool: string | null;
  outcome: string;
  skip_rule: string | null;
  sig_hash: string | null;
  detail_hash: string | null;
}

function logRows(root: string): LogRow[] {
  return withDb(
    root,
    (db) =>
      // SAFETY: the SELECT names exactly the LogRow columns.
      db
        .prepare(`SELECT session_id, tool, outcome, skip_rule, sig_hash, detail_hash FROM failure_log ORDER BY id`)
        .all() as LogRow[],
  );
}

/** Tombstone a lesson text the way `hippo reject` does, so storing it again throws. */
function rejectLesson(root: string, text: string): void {
  withDb(root, (db) =>
    insertRejectedValue(db, {
      tenantId: 'default',
      digest: rejectionDigest(text),
      reason: 'test',
      rejectedBy: 'cli',
      rejectedAt: new Date().toISOString(),
      normalizedChars: normalizeValueForRejection(text).length,
    }),
  );
}

async function capturedInOrder(home: string, payloads: readonly JsonValue[]): Promise<string[]> {
  const outcomes: string[] = [];
  for (const p of payloads) outcomes.push(await captureToolFailure(failureTarget(home), p));
  return outcomes;
}

describe('repeat-error rate', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('failure-log');
  });

  it('counts a repeat only when another session hit the signature first', () => {
    const { failureLog } = sqliteSyncStore(home);
    const log = (sessionId: string | null, sigHash: string, outcome: FailureOutcome = 'duplicate'): number =>
      failureLog.record({ tenantId: 'default', sessionId, tool: 'Bash', outcome, sigHash });
    log('s1', 'A', 'stored');
    log('s1', 'A');
    log('s2', 'A');
    log('s2', 'B', 'stored');
    log(null, 'B');
    log('s3', 'C', 'skipped-routine');
    log('s4', 'C', 'store-failed');
    failureLog.record({ tenantId: 'other', sessionId: 's9', outcome: 'stored', sigHash: 'D' });
    log('s5', 'B');

    withDb(home, (db) => {
      // s1's retry is the same session; s3's routine C is not rated, so s4's C is new; the null-session B is ignored.
      expect(summarizeFailures(db, 'default', ago(1))).toMatchObject({
        total: 8,
        rated: 6,
        repeats: 2,
        sessions: 4,
        outcomes: {
          stored: 2,
          duplicate: 4,
          'store-failed': 1,
          'skipped-interrupt': 0,
          'skipped-routine': 1,
          'skipped-invalid': 0,
        },
      });
    });
  });

  it('a session that hit a signature first never repeats it, even after another session hits it too', () => {
    const { failureLog } = sqliteSyncStore(home);
    for (const sessionId of ['a', 'b', 'a']) {
      failureLog.record({ tenantId: 'default', sessionId, outcome: 'duplicate', sigHash: 'E' });
    }
    withDb(home, (db) =>
      expect(summarizeFailures(db, 'default', ago(1))).toMatchObject({ rated: 3, repeats: 1, sessions: 2 }),
    );
  });

  it('looks back past the window and prunes rows past retention', () => {
    const { failureLog } = sqliteSyncStore(home);
    withDb(home, (db) => {
      expect(summarizeFailures(db, 'default', ago(30))).toMatchObject({ total: 0, rated: 0, repeats: 0, sessions: 0 });
      failureLog.record({ tenantId: 'default', sessionId: 'old', outcome: 'stored', sigHash: 'A', now: ago(200) });
      failureLog.record({ tenantId: 'default', sessionId: 's0', outcome: 'stored', sigHash: 'B', now: ago(10) });
      failureLog.record({ tenantId: 'default', sessionId: 's1', outcome: 'duplicate', sigHash: 'B' });
      failureLog.record({ tenantId: 'default', sessionId: 's1', outcome: 'stored', sigHash: 'A' });
      // SAFETY: COUNT(*) aggregate row.
      const old = db.prepare(`SELECT COUNT(*) AS n FROM failure_log WHERE session_id = 'old'`).get() as { n: number };
      expect(Number(old.n)).toBe(0);
      expect(summarizeFailures(db, 'default', ago(1))).toMatchObject({ total: 2, rated: 2, repeats: 1 });
    });
  });
});

describe('failuresPerSession', () => {
  const rated = (rows: ReadonlyArray<readonly [string, string]>, ts = ago(0)) =>
    rows.map(([sessionId, sigHash]) => ({ ts, sessionId, sigHash }));

  it('counts a repeat only when another session hit the signature first', () => {
    const rows = rated([
      ['s1', 'A'],
      ['s1', 'A'],
      ['s2', 'A'],
      ['s2', 'B'],
      ['s4', 'C'],
      ['s5', 'B'],
    ]);
    expect(failuresPerSession(rows, ago(1))).toEqual([
      { sessionId: 's1', failures: 2, repeats: 0 },
      { sessionId: 's2', failures: 2, repeats: 1 },
      { sessionId: 's4', failures: 1, repeats: 0 },
      { sessionId: 's5', failures: 1, repeats: 1 },
    ]);
  });

  it('a session that hit a signature first never repeats it, even after another session hits it too', () => {
    const rows = rated([
      ['a', 'E'],
      ['b', 'E'],
      ['a', 'E'],
    ]);
    expect(failuresPerSession(rows, ago(1))).toEqual([
      { sessionId: 'a', failures: 2, repeats: 0 },
      { sessionId: 'b', failures: 1, repeats: 1 },
    ]);
  });

  it('a row before the window is not counted but still decides who hit a signature first', () => {
    const rows = [...rated([['s0', 'B']], ago(10)), ...rated([['s1', 'B']])];
    expect(failuresPerSession(rows, ago(1))).toEqual([{ sessionId: 's1', failures: 1, repeats: 1 }]);
  });
});

describe('capture-error logs every failure, never its text', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('failure-capture');
  });

  it('logs each outcome with its session, tool and routine rule, and only hashes of the error', async () => {
    const error = 'Exit code 1\nError: connect ECONNREFUSED db.internal.example:5432 as deploy_user';
    const payloads: JsonValue[] = [
      { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' }, error },
      { session_id: 's2', tool_name: 'Bash', tool_input: { command: 'npm test' }, error },
      { session_id: 's2', tool_name: 'Grep', error: 'No matches found for pattern foo' },
      { session_id: 's2', tool_name: 'Bash', error: 'Interrupted by user', is_interrupt: true },
      { session_id: 's2', tool_name: 'Bash', error: 'short' },
      { session_id: ' ', tool_name: 'Edit', error: 'String to replace not found in file.' },
    ];
    expect(await capturedInOrder(home, payloads)).toEqual([
      'stored',
      'duplicate',
      'skipped-routine',
      'skipped-interrupt',
      'skipped-invalid',
      'stored',
    ]);
    const rows = logRows(home);
    expect(rows.map((r) => [r.session_id, r.tool, r.outcome, r.skip_rule])).toEqual([
      ['s1', 'Bash', 'stored', null],
      ['s2', 'Bash', 'duplicate', null],
      ['s2', 'Grep', 'skipped-routine', 'no-match'],
      ['s2', 'Bash', 'skipped-interrupt', null],
      ['s2', 'Bash', 'skipped-invalid', null],
      [null, 'Edit', 'stored', null],
    ]);
    const hex = (h: string | null): boolean | null => (h === null ? null : /^[0-9a-f]{16}$/.test(h));
    expect(rows.map((r) => [hex(r.sig_hash), hex(r.detail_hash)])).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [null, null],
      [null, null],
      [true, true],
    ]);
    expect(rows[1]).toMatchObject({ sig_hash: rows[0]!.sig_hash, detail_hash: rows[0]!.detail_hash });
    const everything = JSON.stringify(withDb(home, (db) => db.prepare(`SELECT * FROM failure_log`).all()));
    expect(everything).not.toMatch(/ECONNREFUSED|internal|deploy_user|pattern foo|String to replace|npm/i);
    withDb(home, (db) => expect(summarizeFailures(db, 'default', ago(1))).toMatchObject({ rated: 2, repeats: 1 }));
  });

  it('keeps a finer detail hash that tells apart failures the lesson text merges', async () => {
    const silent = (command: string) => ({
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command },
      error: 'Exit code 1 (no output)',
    });
    const banner = `Error: ${'build banner line '.repeat(12)}`;
    const payloads: JsonValue[] = [
      silent('npm test'),
      silent('node build.js'),
      { session_id: 's1', tool_name: 'Bash', error: `${banner}missing semicolon` },
      { session_id: 's1', tool_name: 'Bash', error: `${banner}type mismatch` },
    ];
    expect(await capturedInOrder(home, payloads)).toEqual(['stored', 'duplicate', 'stored', 'duplicate']);
    const [a, b, c, d] = logRows(home);
    expect(b!.sig_hash).toBe(a!.sig_hash);
    expect(b!.detail_hash).not.toBe(a!.detail_hash);
    expect(d!.sig_hash).toBe(c!.sig_hash);
    expect(d!.detail_hash).not.toBe(c!.detail_hash);
  });

  it('logs a failure as store-failed when storing it throws, and still throws', async () => {
    const payload = { session_id: 's1', tool_name: 'Bash', error: 'Exit code 2\nerror TS2304: Cannot find name foo' };
    rejectLesson(home, lessonFromFailure(payload).text!);
    await expect(captureToolFailure(failureTarget(home), payload)).rejects.toThrow(RejectedValueError);
    expect(logRows(home).map((r) => [r.session_id, r.outcome, r.sig_hash !== null])).toEqual([
      ['s1', 'store-failed', true],
    ]);
    withDb(home, (db) => expect(summarizeFailures(db, 'default', ago(1))).toMatchObject({ total: 1, rated: 1 }));
  });

  it('pins the signature hash, because logged hashes cannot be recomputed after a change', () => {
    expect(blockHash(failureSignature('Bash: Exit code 2 src/a.ts(12,3): error TS2304: Cannot find name foo'))).toBe(
      '19e1075d4670c921',
    );
  });

  it('caps the session id and tool name it keeps', async () => {
    await captureToolFailure(failureTarget(home), {
      session_id: 's'.repeat(500),
      tool_name: 't'.repeat(500),
      error: 'Exit code 1\nError: something real broke',
    });
    const [row] = logRows(home);
    expect([row!.session_id!.length, row!.tool!.length]).toEqual([128, 128]);
  });
});

describe('hippo failures', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeStore('failures-cli').base;
  });
  // In process, throwing on a non-zero exit as execFileSync did, so coverage sees the hook and the report.
  // In process, with execFileSync's throw on a non-zero exit, so coverage sees the hook and the report.
  async function run(args: string[], input = '', cwd = dir): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: join(cwd, 'global'), HOME: cwd, USERPROFILE: cwd };
    delete env.HIPPO_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = await runCliAs(args, { env, cwd, input });
    if (r.status !== 0) throw new Error(`hippo ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  }
  const broke = (session?: string, what = 'something real broke'): string =>
    JSON.stringify({ session_id: session, tool_name: 'Bash', error: `Exit code 1\nError: ${what}` });

  it('reports outcomes and repeats from what the hook logged, including a lesson it could not save', async () => {
    expect(await run(['failures'])).toContain('No failed tool calls recorded in the last 30 days.');
    const build = (session: string): string =>
      JSON.stringify({
        session_id: session,
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        error: 'Exit code 2\nsrc/a.ts(12,3): error TS2304: Cannot find name foo',
      });
    const refused = { session_id: 's3', tool_name: 'Bash', error: 'Exit code 1\nError: Cannot find module express' };
    rejectLesson(join(dir, '.hippo'), lessonFromFailure(refused).text!);
    await run(['capture-error'], build('s1'));
    await run(['capture-error'], build('s2'));
    await run(
      ['capture-error'],
      JSON.stringify({ session_id: 's2', tool_name: 'Grep', error: 'No matches found for pattern foo' }),
    );
    // Storing this one throws; the hook still exits 0 (run would throw otherwise) and the log keeps it.
    await run(['capture-error'], JSON.stringify(refused));

    const summary = JSON.parse(await run(['failures', '--json']));
    expect(summary).toMatchObject({ total: 4, rated: 3, repeats: 1, sessions: 3 });
    expect(summary.outcomes).toMatchObject({ stored: 1, duplicate: 1, 'store-failed': 1, 'skipped-routine': 1 });
    const text = await run(['failures', '--days', '7']);
    expect(text).toContain('last 7 days');
    expect(text).toContain('(1 new, 1 already in memory, 1 could not be saved)');
    expect(text).toContain('Repeats: 1 of 3 errors first happened in another session.');
    expect(await run(['failures', '--days', '120'])).toContain('last 120 days (rows are kept 90 days)');
  });

  it('still exits 0 and stores the lesson when the failure log is broken', async () => {
    const root = join(dir, '.hippo');
    withDb(root, (db) => db.exec('DROP TABLE failure_log'));
    await run(['capture-error'], broke('s1'));
    expect(loadAllEntries(root, 'default').map((e) => e.content)).toEqual([
      'Bash: Exit code 1 Error: something real broke',
    ]);
  });

  it('reads the store the hook fell back to, never creates one, and names errors without a session', async () => {
    const bare = makeRoot('failures-bare', { init: false });
    await expect(run(['failures', '--global'], '', bare)).rejects.toThrow();
    expect(existsSync(join(bare, 'global'))).toBe(false);
    initTestStore(join(bare, 'global'));
    await run(['capture-error'], broke('s1'), bare);
    await run(['capture-error'], broke(undefined, 'another thing broke'), bare);
    expect(JSON.parse(await run(['failures', '--json'], '', bare))).toMatchObject({
      total: 2,
      rated: 1,
      repeats: 0,
      sessions: 1,
    });
    expect(await run(['failures'], '', bare)).toContain(
      'Repeats: 0 of 1 errors first happened in another session. 1 more had no session id.',
    );
  });
});
