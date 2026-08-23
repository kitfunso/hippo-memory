import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getHippoRoot, loadActiveTaskSnapshot, saveActiveTaskSnapshot } from '../src/store.js';

// DF1 (docs/plans/2026-08-23-df1-snapshot-lifecycle.md) T3 test 6:
// session-end wiring. `cmdSessionEnd` extracts `payload.session_id` from the
// SessionEnd hook's stdin JSON and passes `--session-id` to the detached
// `__session-end-worker`; the worker closes that session's own active
// snapshot AFTER sleep+capture. Real built CLI, real detached child, no
// mocks — same idiom as tests/pre-compact-e2e.test.ts.

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

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

function runHippo(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [HIPPO_JS, ...args], {
    cwd,
    env,
    input,
    encoding: 'utf8',
  });
}

function initHippo(cwd: string, env: NodeJS.ProcessEnv): void {
  const result = runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], cwd, env);
  expect(result.status).toBe(0);
}

// The detached session-end worker can still hold a brief Windows lock on the
// SQLite WAL/shm files after our poll condition is satisfied (same class of
// issue as tests/github-v1.3.1-hotfix.test.ts's safeRmSync). Best-effort.
function safeRmSync(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup only — a leftover scratch tmpdir is harmless.
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A one-off read after (rather than during) the detached worker's window
 * can still race its last DB write on a loaded machine — same cross-process
 * WAL contention `waitUntil` tolerates. Retry a few times before giving up. */
async function loadSnapshotRetrying(
  hippoRoot: string,
  tenantId: string,
  attempts = 10,
  delayMs = 100,
): Promise<ReturnType<typeof loadActiveTaskSnapshot>> {
  for (let i = 0; i < attempts; i++) {
    try {
      return loadActiveTaskSnapshot(hippoRoot, tenantId);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleepMs(delayMs);
    }
  }
  // Unreachable (the loop above always returns or throws), but keeps the
  // function's control flow provably total for the type checker.
  throw new Error('loadSnapshotRetrying: unreachable');
}

/** `session-end` spawns a DETACHED worker and returns immediately (by
 * design — the parent must never block on it). Poll for the condition the
 * worker is expected to eventually produce, bounded so a real wiring bug
 * fails the test instead of hanging it.
 *
 * `check()` opens its own SQLite connection while a SEPARATE OS process
 * (the detached worker) may be mid-write on the same file — an occasional
 * transient "database is locked" from that race is expected polling noise,
 * not a real failure, so a throw counts as "not yet" and the loop keeps
 * going. Only run out of the clock still fails the test.
 *
 * Default bound is generous (25s, under this project's 30s global
 * `testTimeout` in vitest.config.ts) because the detached worker is a real
 * separate OS process competing for CPU/IO with the rest of a full `npm
 * test` run — under full-suite parallel load this project's own heavier
 * tests (e.g. dag-rebuild-summaries.test.ts) observably take well over a
 * minute, so 8s was too tight for this worker's sleep+capture+close chain. */
async function waitUntil(check: () => boolean, timeoutMs = 25_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch (err) {
      lastError = err;
    }
    await sleepMs(intervalMs);
  }
  try {
    if (check()) return;
  } catch (err) {
    lastError = err;
  }
  const lastErrorMessage = lastError instanceof Error ? lastError.message : String(lastError ?? '');
  throw new Error(
    `condition not met within ${timeoutMs}ms${lastErrorMessage ? ` (last error: ${lastErrorMessage})` : ''}`,
  );
}

describe('6. session-end wiring: --session-id argv + worker close (DF1 T3)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ dir, env } = withScratchEnv());
    initHippo(dir, env);
  });

  afterEach(() => {
    safeRmSync(dir);
  });

  it('payload session_id is threaded through to the worker, which closes that session\'s own active snapshot', async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'session-end wiring task',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-end-close-me',
      source: 'pre-compact',
    });

    const payload = JSON.stringify({ session_id: 'sess-end-close-me', hook_event_name: 'SessionEnd' });
    const result = runHippo(['session-end'], dir, env, payload);
    expect(result.status).toBe(0);

    // The parent returns immediately; the detached worker does the close.
    // waitUntil's own successful return IS the assertion — no closed once,
    // still-closed re-check after it (the worker's last DB write already
    // happened by the time the condition holds; a second read only adds
    // needless exposure to the cross-process WAL race waitUntil tolerates).
    await waitUntil(() => loadActiveTaskSnapshot(hippoRoot, 'default') === null);
  });

  it('a DIFFERENT session\'s snapshot survives: session-end for session B never closes session A\'s active row', async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'belongs to session A',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-a-not-ending',
      source: 'pre-compact',
    });

    // session-end fires for a DIFFERENT session (B) — A's row must survive.
    const payload = JSON.stringify({ session_id: 'sess-b-ending', hook_event_name: 'SessionEnd' });
    const result = runHippo(['session-end'], dir, env, payload);
    expect(result.status).toBe(0);

    // Give the detached worker a fair window to run (and prove it does NOT
    // touch A's row, not just that we didn't wait long enough).
    await sleepMs(1500);
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

    await waitUntil(
      () => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('skip: no session_id'),
    );

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

    await waitUntil(
      () => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('active snapshot'),
    );

    const logText = fs.readFileSync(logFile, 'utf8');
    // No line may START with the injected content — every log line stays
    // [hippo]-prefixed with the control chars stripped from the id.
    const forgedLine = logText.split('\n').find((l) => l.startsWith('FORGED'));
    expect(forgedLine).toBeUndefined();
    expect(logText).toContain('sess-evilFORGED [hippo] fake linesess-tail');
  });
});
