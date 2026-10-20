import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type SpawnSyncReturns } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getHippoRoot } from '../../src/base/scope/project-identity.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { waitFor } from '../_helpers/wait-for.js';
import { loadActiveTaskSnapshot, loadLatestHandoff, saveActiveTaskSnapshot } from '../_helpers/root-forms.js';

// DF1 (docs/plans/2026-08-23-df1-snapshot-lifecycle.md) T3 test 6:
// session-end wiring. `handleSessionEnd` extracts `payload.session_id` from the
// SessionEnd hook's stdin JSON and passes `--session-id` to the detached
// `__session-end-worker`; the worker closes that session's own active
// snapshot AFTER sleep+capture. Real built CLI, real detached child, no
// mocks, the same idiom as tests/core/pre-compact-e2e.process.test.ts.

function withScratchEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-session-end-e2e-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIPPO_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
  };
  return { dir, env };
}

function runHippo(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): SpawnSyncReturns<string> {
  return hippoRun(args, { cwd, env, input });
}

function initHippo(cwd: string, env: NodeJS.ProcessEnv): void {
  const result = runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], cwd, env);
  expect(result.status).toBe(0);
}

// The detached session-end worker can still hold a brief Windows lock on the
// SQLite WAL/shm files after our poll condition is satisfied (same class of
// issue as tests/store/github-rollback-guard-and-deletion-atomicity.test.ts's safeRmSync). Best-effort.
function safeRmSync(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup only — a leftover scratch tmpdir is harmless.
  }
}

// The detached worker is a real process: a throw while it holds the WAL lock counts as "not yet", and the bound is generous under load.
const WORKER_WAIT = { timeoutMs: 25_000, intervalMs: 50, retryOnThrow: true } as const;

/** A read just after the detached worker's window can still race its last DB write on a loaded machine; retry until it lands. */
async function loadSnapshotRetrying(
  hippoRoot: string,
  tenantId: string,
): Promise<ReturnType<typeof loadActiveTaskSnapshot>> {
  let snapshot: ReturnType<typeof loadActiveTaskSnapshot> = null;
  await waitFor(
    () => {
      snapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);
      return true;
    },
    { ...WORKER_WAIT, timeoutMs: 1_000, intervalMs: 100, what: 'the snapshot readable' },
  );
  return snapshot;
}

const CLOSE_STEP = /closed \d+ active snapshot\(s\) for session |snapshot close failed: /;

/** The worker's close-step line, success OR failure, so a failed close fails the
 * test fast with the worker's own error instead of waiting out the clock.
 * Reads the worker's `--log-file`, never the database: each database open runs
 * migrations that write, so a database poll made the worker's own close fail. */
function closeStepLogged(logFile: string): boolean {
  return fs.existsSync(logFile) && CLOSE_STEP.test(fs.readFileSync(logFile, 'utf8'));
}

const waitForCloseStep = (logFile: string): Promise<void> =>
  waitFor(() => closeStepLogged(logFile), { ...WORKER_WAIT, what: 'the worker close step in the log' });

describe('6. session-end wiring: --session-id argv + worker close', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ dir, env } = withScratchEnv());
    initHippo(dir, env);
  });

  afterEach(() => {
    safeRmSync(dir);
  });

  it("payload session_id is threaded through to the worker, which closes that session's own active snapshot", async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'session-end wiring task',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-end-close-me',
      source: 'pre-compact',
    });

    const logFile = path.join(dir, 'session-end.log');
    const payload = JSON.stringify({ session_id: 'sess-end-close-me', hook_event_name: 'SessionEnd' });
    const result = runHippo(['session-end', '--log-file', logFile], dir, env, payload);
    expect(result.status).toBe(0);

    // The parent returns immediately; wait on the detached worker's own close
    // line (see closeStepLogged), then read the row once.
    await waitForCloseStep(logFile);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('closed 1 active snapshot(s) for session sess-end-close-me');
    expect(await loadSnapshotRetrying(hippoRoot, 'default')).toBeNull();
  });

  it('a payload that starts with a byte-order mark still names its session to the worker', async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'byte-order-mark task',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-bom',
      source: 'pre-compact',
    });

    const logFile = path.join(dir, 'session-end-bom.log');
    const payload = '\uFEFF' + JSON.stringify({ session_id: 'sess-bom', hook_event_name: 'SessionEnd' });
    expect(runHippo(['session-end', '--log-file', logFile], dir, env, payload).status).toBe(0);

    await waitForCloseStep(logFile);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('closed 1 active snapshot(s) for session sess-bom');
    expect(await loadSnapshotRetrying(hippoRoot, 'default')).toBeNull();
  });

  it("a DIFFERENT session's snapshot survives: session-end for session B never closes session A's active row", async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'belongs to session A',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-a-not-ending',
      source: 'pre-compact',
    });

    // session-end fires for a DIFFERENT session (B) — A's row must survive.
    const logFile = path.join(dir, 'session-end.log');
    const payload = JSON.stringify({ session_id: 'sess-b-ending', hook_event_name: 'SessionEnd' });
    const result = runHippo(['session-end', '--log-file', logFile], dir, env, payload);
    expect(result.status).toBe(0);

    // Wait until the worker reports its close step, so the survival check
    // proves it ran and closed nothing rather than that we did not wait long enough.
    await waitForCloseStep(logFile);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('closed 0 active snapshot(s) for session sess-b-ending');
    const snapshot = await loadSnapshotRetrying(hippoRoot, 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.status).toBe('active');
    expect(snapshot!.session_id).toBe('sess-a-not-ending');
  });

  it('no session_id in the SessionEnd payload -> worker no-ops the close (snapshot stays active) and logs one skip line', async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'no-session-id-in-payload task',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-should-survive',
      source: 'pre-compact',
    });

    const logFile = path.join(dir, 'session-end.log');
    const payload = JSON.stringify({ hook_event_name: 'SessionEnd' }); // no session_id field
    const result = runHippo(['session-end', '--log-file', logFile], dir, env, payload);
    expect(result.status).toBe(0);

    await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('skip: no session_id'), {
      ...WORKER_WAIT,
      what: 'the worker skip line in the log',
    });

    const snapshot = await loadSnapshotRetrying(hippoRoot, 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.status).toBe('active');
    expect(fs.readFileSync(logFile, 'utf8')).toContain(
      'skip: no session_id in SessionEnd payload, active snapshot left untouched',
    );
  });

  it('log-forgery guard: a session_id with embedded newlines cannot inject fake [hippo] log lines', async () => {
    // PR #146 review finding: appendSessionEndCloseLog interpolates the
    // payload-controlled session_id, so it must run the same
    // sanitizeLogMessage guard appendPreCompactLog documents (capture.ts
    // "Log-forgery guard" comment). Red-under-old: without the guard the
    // crafted id below writes a standalone "FORGED [hippo] fake line".
    const logFile = path.join(dir, 'session-end-forgery.log');
    const evilId = 'sess-evil\nFORGED [hippo] fake line\nsess-tail';
    const payload = JSON.stringify({ session_id: evilId, hook_event_name: 'SessionEnd' });
    const result = runHippo(['session-end', '--log-file', logFile], dir, env, payload);
    expect(result.status).toBe(0);

    await waitForCloseStep(logFile);

    const logText = fs.readFileSync(logFile, 'utf8');
    // No line may START with the injected content — every log line stays
    // [hippo]-prefixed with the control chars stripped from the id.
    const forgedLine = logText.split('\n').find((l) => l.startsWith('FORGED'));
    expect(forgedLine).toBeUndefined();
    expect(logText).toContain('sess-evilFORGED [hippo] fake linesess-tail');
  });

  it('a session that never compacted gets a handoff from its own transcript', async () => {
    const hippoRoot = getHippoRoot(dir);
    const transcriptPath = path.join(dir, 'session.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        { type: 'user', message: { role: 'user', content: 'add rate limiting to the webhook endpoint' } },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Limiter added; the test is next.' }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );

    const logFile = path.join(dir, 'session-end-no-compact.log');
    const payload = JSON.stringify({
      session_id: 'sess-no-compact',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionEnd',
    });
    expect(runHippo(['session-end', '--log-file', logFile], dir, env, payload).status).toBe(0);

    await waitForCloseStep(logFile);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('wrote handoff for session sess-no-compact');
    expect(loadLatestHandoff(hippoRoot, 'default', 'sess-no-compact')?.nextAction).toBe(
      'Limiter added; the test is next.',
    );
  });

  it('reads the transcript even while the session holds the snapshot, in case another session takes the slot before the write', async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'from the snapshot',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-own',
      source: 'pre-compact',
    });
    // A tail with nothing to read is the one read that leaves a log line; the slot flip itself cannot be timed from a test.
    const transcriptPath = path.join(dir, 'own.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'summary' }) + '\n');

    const logFile = path.join(dir, 'session-end-own-snapshot.log');
    const payload = JSON.stringify({
      session_id: 'sess-own',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionEnd',
    });
    expect(runHippo(['session-end', '--log-file', logFile], dir, env, payload).status).toBe(0);

    await waitForCloseStep(logFile);
    const logText = fs.readFileSync(logFile, 'utf8');
    expect(logText).toContain('skip: empty summary');
    expect(logText).toContain('wrote handoff for session sess-own');
    expect(loadLatestHandoff(hippoRoot, 'default', 'sess-own')?.taskId).toBe('from the snapshot');
  });

  it("a payload whose transcript is missing skips capture instead of reading another project's newest transcript", async () => {
    const other = path.join(dir, '.claude', 'projects', 'other-project');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
      path.join(other, 'newest.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: "let's go with PostgreSQL" } }) + '\n',
    );

    const logFile = path.join(dir, 'session-end-missing-transcript.log');
    const payload = JSON.stringify({
      session_id: 'sess-gone',
      transcript_path: path.join(dir, 'gone.jsonl'),
      hook_event_name: 'SessionEnd',
    });
    const result = runHippo(['session-end', '--log-file', logFile], dir, env, payload);
    expect(result.status).toBe(0);

    await waitForCloseStep(logFile);
    const logText = fs.readFileSync(logFile, 'utf8');
    expect(logText).toContain('skip capture: no transcript for this session');
    expect(logText).not.toContain('capturing session');
  });
});
