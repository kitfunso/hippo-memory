import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getHippoRoot, loadActiveTaskSnapshot } from '../src/store.js';

// Plan: hippo/trajectories/01M2ZSMFG8JXSM7PH10EVZNZBW/plan.md. Real spawn,
// real store, no mocks, same idiom as tests/pre-compact-e2e.test.ts.
const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

function withScratchEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-stdin-bounded-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIPPO_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
  };
  return { dir, env };
}

function transcriptJsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function runHippo(args: string[], cwd: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd, env, encoding: 'utf8' });
}

function initHippo(cwd: string, env: NodeJS.ProcessEnv): void {
  const result = runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], cwd, env);
  expect(result.status).toBe(0);
}

// Detached session-end workers can briefly hold a Windows lock on the
// SQLite WAL/shm files (mirrors session-end-snapshot-close.test.ts).
function safeRmSync(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup only
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, timeoutMs = 25_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleepMs(intervalMs);
  }
  if (!check()) throw new Error(`condition not met within ${timeoutMs}ms`);
}

// case 1's payload-less run takes the "no session_id" branch, which
// session-end-snapshot-close.test.ts's own CLOSE_STEP regex never matches.
const SESSION_END_DONE = /closed \d+ active snapshot\(s\) for session |snapshot close failed: |skip: no session_id in SessionEnd payload/;
function sessionEndDoneLogged(logFile: string): boolean {
  return fs.existsSync(logFile) && SESSION_END_DONE.test(fs.readFileSync(logFile, 'utf8'));
}

interface BoundedRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

type StdinPlan =
  | { mode: 'ignore' }
  | { mode: 'idle' }
  | { mode: 'write'; text: string; end: boolean; delayMs?: number };

// Long enough the fix's <=1000ms default wait never reaches it, short
// enough to fail fast instead of waiting out vitest's 30s global timeout.
const KILL_GUARD_MS = 15_000;

/** spawnSync can't express "stdin open, never written": its child stdin
 * closes the instant the call returns. Case 1 needs a real spawn. */
function spawnBounded(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: StdinPlan,
): Promise<BoundedRunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [HIPPO_JS, ...args], {
      cwd,
      env,
      stdio: [stdin.mode === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

    // This guard (not vitest's) is what ends a red-phase hang: it names
    // the stuck command instead of a generic "test timed out".
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hippo ${args.join(' ')} did not exit within ${KILL_GUARD_MS}ms (killed by test guard)`));
    }, KILL_GUARD_MS);

    child.once('error', (err) => {
      clearTimeout(guard);
      reject(err);
    });
    child.once('close', (status, signal) => {
      clearTimeout(guard);
      resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - start });
    });

    if (stdin.mode === 'write') {
      const write = (): void => {
        child.stdin!.write(stdin.text, () => {
          if (stdin.end) child.stdin!.end();
        });
      };
      if (stdin.delayMs) setTimeout(write, stdin.delayMs);
      else write();
    }
    // 'idle': stdin stays open, untouched. 'ignore': child.stdin is null.
  });
}

/** Writes a synthetic transcript and matching PreCompact payload for `sessionId`. */
function seedPreCompactPayload(dir: string, sessionId: string): { transcriptPath: string; payloadText: string } {
  const transcriptPath = path.join(dir, `${sessionId}-transcript.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    transcriptJsonl([
      { type: 'user', message: { role: 'user', content: `Investigate the ${sessionId} regression.` } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Fixed the ${sessionId} regression.` }] } },
    ]),
  );
  const payloadText = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: dir,
    hook_event_name: 'PreCompact',
  });
  return { transcriptPath, payloadText };
}

function expectRowFor(dir: string, sessionId: string): void {
  const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
  expect(snapshot).not.toBeNull();
  expect(snapshot!.session_id).toBe(sessionId);
  expect(snapshot!.task).toContain('Investigate');
  expect(snapshot!.next_step).toContain('Fixed');
}

describe('hippo stdin: bounded read for the optional hook payload (plan: stdin-idle-hang)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ dir, env } = withScratchEnv());
    initHippo(dir, env);
  });

  afterEach(() => {
    safeRmSync(dir);
  });

  describe('case 1: an idle, never-written, never-closed stdin pipe must not hang any of the five commands', () => {
    const fastEnv = () => ({ ...env, HIPPO_STDIN_WAIT_MS: '200' });

    it('pre-compact', async () => {
      const result = await spawnBounded(['pre-compact'], dir, fastEnv(), { mode: 'idle' });
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    });

    it('compact-resume', async () => {
      const result = await spawnBounded(['compact-resume'], dir, fastEnv(), { mode: 'idle' });
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    });

    it('context', async () => {
      const result = await spawnBounded(['context'], dir, fastEnv(), { mode: 'idle' });
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    });

    it('session-end', async () => {
      const logFile = path.join(dir, 'session-end.log');
      const result = await spawnBounded(['session-end', '--log-file', logFile], dir, fastEnv(), { mode: 'idle' });
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      // Let the detached worker finish before afterEach removes dir.
      await waitUntil(() => sessionEndDoneLogged(logFile));
    });

    it('capture --last-session', async () => {
      const result = await spawnBounded(['capture', '--last-session'], dir, fastEnv(), { mode: 'idle' });
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    });
  });

  it('case 2: payload written then ended writes the task_snapshots row', async () => {
    const { payloadText } = seedPreCompactPayload(dir, 'sess-case2');
    const result = await spawnBounded(['pre-compact'], dir, env, { mode: 'write', text: payloadText, end: true });
    expect(result.status).toBe(0);
    expectRowFor(dir, 'sess-case2');
  });

  it('case 3: payload written but never ended still writes the row, inside the guard', async () => {
    const { payloadText } = seedPreCompactPayload(dir, 'sess-case3');
    const result = await spawnBounded(
      ['pre-compact'],
      dir,
      { ...env, HIPPO_STDIN_WAIT_MS: '200' },
      { mode: 'write', text: payloadText, end: false },
    );
    expect(result.status).toBe(0);
    expectRowFor(dir, 'sess-case3');
  });

  it('case 4: payload delivered after a 100ms delay, default window, still parses', async () => {
    const { payloadText } = seedPreCompactPayload(dir, 'sess-case4');
    const result = await spawnBounded(
      ['pre-compact'],
      dir,
      env,
      { mode: 'write', text: payloadText, end: true, delayMs: 100 },
    );
    expect(result.status).toBe(0);
    expectRowFor(dir, 'sess-case4');
  });

  it('case 5: garbage HIPPO_STDIN_WAIT_MS falls back to the 1000ms default, never zero wait', async () => {
    const result = await spawnBounded(
      ['context'],
      dir,
      { ...env, HIPPO_STDIN_WAIT_MS: 'abc' },
      { mode: 'idle' },
    );
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
  });

  it('cases 6+7: a timed-out pre-compact never overwrites session A with an auto-discovered decoy, and logs the skip', async () => {
    // Literal, not read back from the store: a blank field here would
    // silently inherit the decoy's value via capture.ts's CX6 fallback.
    const SESSION_A_TASK = 'Investigate the flaky upload retry test.';
    const SESSION_A_NEXT_STEP = 'Added a regression test for the retry backoff.';
    const SESSION_A_SUMMARY =
      '# Session Summary\n\n## User Messages\n- Investigate the flaky upload retry test.\n\n' +
      '## Assistant Responses\nAdded a regression test for the retry backoff.';

    const sessionATranscript = path.join(dir, 'session-a-transcript.jsonl');
    fs.writeFileSync(
      sessionATranscript,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: SESSION_A_TASK } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: SESSION_A_NEXT_STEP }] } },
      ]),
    );
    const seedPayload = JSON.stringify({
      session_id: 'session-A',
      transcript_path: sessionATranscript,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });
    const seed = (): Promise<BoundedRunResult> =>
      spawnBounded(['pre-compact'], dir, env, { mode: 'write', text: seedPayload, end: true });

    // a. Seed session A via the explicit-path branch.
    let result = await seed();
    expect(result.status).toBe(0);
    let snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.session_id).toBe('session-A');

    // b. Decoy sits where auto-discovery actually looks (capture.ts:742-765).
    const decoyDir = path.join(dir, '.claude', 'projects', 'other-project');
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyDir, 'decoy.jsonl'),
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'we decided to use RabbitMQ for the decoy session, this must never leak into session A.' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DECOY SESSION marker: rotate the queue consumer next.' }] } },
      ]),
    );

    // c. Positive control: a true manual invocation (stdin closed, not
    // idle) must pick up the decoy, proving the overwrite path is live here.
    result = await spawnBounded(['pre-compact'], dir, env, { mode: 'ignore' });
    expect(result.status).toBe(0);
    snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.summary).toContain('DECOY SESSION');

    // Re-seed session A before the guarded run.
    result = await seed();
    expect(result.status).toBe(0);

    // d. The guard: stdin OPEN and never written must fail closed, not
    // fall through to auto-discovery the way step c did.
    const logFile = path.join(dir, 'pre-compact-guard.log');
    result = await spawnBounded(
      ['pre-compact', '--log-file', logFile],
      dir,
      { ...env, HIPPO_STDIN_WAIT_MS: '200' },
      { mode: 'idle' },
    );
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();

    snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.session_id).toBe('session-A');
    expect(snapshot!.task).toBe(SESSION_A_TASK);
    expect(snapshot!.summary).toBe(SESSION_A_SUMMARY);
    expect(snapshot!.next_step).toBe(SESSION_A_NEXT_STEP);
    expect(snapshot!.summary).not.toContain('DECOY SESSION');

    // 7. The skip must be visible in the log, not silent.
    expect(fs.readFileSync(logFile, 'utf8')).toContain(
      'skip: no PreCompact payload arrived before the stdin wait window closed',
    );
  });
});
