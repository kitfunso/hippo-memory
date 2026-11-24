import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getHippoRoot } from '../../src/host/project-identity.js';
import { compactionRows } from '../_helpers/compaction-hooks.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { waitFor } from '../_helpers/wait-for.js';
import { loadActiveTaskSnapshot } from '../_helpers/root-forms.js';

const HIPPO_JS = path.resolve(__dirname, '..', '..', 'bin', 'hippo.js');

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

async function initHippo(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCliAs(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd, env });
  expect(result.status).toBe(0);
}

// Detached session-end workers can briefly hold a Windows lock on the
// SQLite WAL/shm files (mirrors session-end-snapshot-close.process.test.ts).
function safeRmSync(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
  }
}

const SESSION_END_DONE =
  /closed \d+ active snapshot\(s\) for session |snapshot close failed: |skip: no session_id in SessionEnd payload/;
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
  | { mode: 'dribble'; text: string; everyMs: number }
  | { mode: 'write'; text: string; end: boolean; delayMs?: number };

const KILL_GUARD_MS = 15_000;

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
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hippo ${args.join(' ')} did not exit within ${KILL_GUARD_MS}ms (killed by test guard)`));
    }, KILL_GUARD_MS);

    let dribble: NodeJS.Timeout | undefined;
    child.once('error', (err) => {
      clearTimeout(guard);
      clearInterval(dribble);
      reject(err);
    });
    child.once('close', (status, signal) => {
      clearTimeout(guard);
      clearInterval(dribble);
      resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - start });
    });

    if (stdin.mode === 'dribble') {
      child.stdin!.on('error', () => {});
      dribble = setInterval(() => {
        child.stdin?.write(stdin.text, () => {});
      }, stdin.everyMs);
    }

    if (stdin.mode === 'write') {
      const write = (): void => {
        child.stdin!.write(stdin.text, () => {
          if (stdin.end) child.stdin!.end();
        });
      };
      if (stdin.delayMs) setTimeout(write, stdin.delayMs);
      else write();
    }
  });
}

function seedPreCompactPayload(dir: string, sessionId: string) {
  const transcriptPath = path.join(dir, `${sessionId}-transcript.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    transcriptJsonl([
      { type: 'user', message: { role: 'user', content: `Investigate the ${sessionId} regression.` } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `Fixed the ${sessionId} regression.` }] },
      },
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
  expect(snapshot!.sessionId).toBe(sessionId);
  expect(snapshot!.task).toContain('Investigate');
  expect(snapshot!.nextStep).toContain('Fixed');
}

describe('hippo stdin: bounded read for the optional hook payload (plan: stdin-idle-hang)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    ({ dir, env } = withScratchEnv());
    await initHippo(dir, env);
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
      await waitFor(() => sessionEndDoneLogged(logFile), {
        what: 'the session-end worker finishing',
        timeoutMs: 25_000,
        intervalMs: 50,
      });
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
    const result = await spawnBounded(['pre-compact'], dir, env, {
      mode: 'write',
      text: payloadText,
      end: true,
      delayMs: 100,
    });
    expect(result.status).toBe(0);
    expectRowFor(dir, 'sess-case4');
  });

  it('case 5: garbage HIPPO_STDIN_WAIT_MS falls back to the 1000ms default, never zero wait', async () => {
    const result = await spawnBounded(['context'], dir, { ...env, HIPPO_STDIN_WAIT_MS: 'abc' }, { mode: 'idle' });
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
  });

  it('cases 6+7: a timed-out pre-compact never overwrites session A with an auto-discovered decoy, and logs the skip', async () => {
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

    let result = await seed();
    expect(result.status).toBe(0);
    let snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionId).toBe('session-A');

    const decoyDir = path.join(dir, '.claude', 'projects', 'other-project');
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyDir, 'decoy.jsonl'),
      transcriptJsonl([
        {
          type: 'user',
          message: {
            role: 'user',
            content: 'we decided to use RabbitMQ for the decoy session, this must never leak into session A.',
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'DECOY SESSION marker: rotate the queue consumer next.' }],
          },
        },
      ]),
    );

    result = await spawnBounded(['pre-compact'], dir, env, { mode: 'ignore' });
    expect(result.status).toBe(0);
    snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.summary).toContain('DECOY SESSION');

    result = await seed();
    expect(result.status).toBe(0);

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
    expect(snapshot!.sessionId).toBe('session-A');
    expect(snapshot!.task).toBe(SESSION_A_TASK);
    expect(snapshot!.summary).toBe(SESSION_A_SUMMARY);
    expect(snapshot!.nextStep).toBe(SESSION_A_NEXT_STEP);
    expect(snapshot!.summary).not.toContain('DECOY SESSION');

    expect(fs.readFileSync(logFile, 'utf8')).toContain(
      'skip: no PreCompact payload arrived before the stdin wait window closed',
    );
  });

  it('a timed-out post-compact saves no compaction record and logs that no payload arrived', async () => {
    const logFile = path.join(dir, 'post-compact-guard.log');
    const result = await spawnBounded(
      ['post-compact', '--log-file', logFile],
      dir,
      { ...env, HIPPO_STDIN_WAIT_MS: '200' },
      { mode: 'idle' },
    );
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(fs.readFileSync(logFile, 'utf8')).toContain(
      'skip: no PostCompact payload arrived before the stdin wait window closed',
    );
    expect(compactionRows(getHippoRoot(dir))).toEqual([]);
  });

  function seedDecoyProject(dir: string): void {
    const decoyDir = path.join(dir, '.claude', 'projects', 'other-project');
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyDir, 'decoy.jsonl'),
      transcriptJsonl([
        {
          type: 'user',
          message: { role: 'user', content: 'DECOY SESSION: this belongs to another project entirely.' },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'DECOY SESSION marker: rotate the queue consumer next.' }],
          },
        },
      ]),
    );
  }

  const NO_TRANSCRIPT = 'No transcript found.';

  it('case 8: a timed-out capture --last-session refuses the cross-project scan', async () => {
    seedDecoyProject(dir);

    let result = await spawnBounded(['capture', '--last-session', '--dry-run'], dir, env, { mode: 'ignore' });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(NO_TRANSCRIPT);

    result = await spawnBounded(
      ['capture', '--last-session', '--dry-run'],
      dir,
      { ...env, HIPPO_STDIN_WAIT_MS: '200' },
      { mode: 'idle' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(NO_TRANSCRIPT);
    expect(result.stdout).not.toContain('DECOY SESSION');
  });

  it('a timed-out compact-resume prints nothing, since the session check cannot read a session it never got', async () => {
    const { payloadText } = seedPreCompactPayload(dir, 'sess-case9');
    let result = await spawnBounded(['pre-compact'], dir, env, { mode: 'write', text: payloadText, end: true });
    expect(result.status).toBe(0);
    expectRowFor(dir, 'sess-case9');

    result = await spawnBounded(['compact-resume'], dir, env, { mode: 'ignore' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Restored after compaction');

    result = await spawnBounded(['compact-resume'], dir, { ...env, HIPPO_STDIN_WAIT_MS: '200' }, { mode: 'idle' });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('## Restored after compaction');
    expect(result.stdout.trim()).toBe('');
  });

  it('case 10: a host that dribbles bytes forever and never ends still exits, via the total cap', async () => {
    const result = await spawnBounded(
      ['context'],
      dir,
      { ...env, HIPPO_STDIN_WAIT_MS: '200' },
      { mode: 'dribble', text: ' ', everyMs: 50 },
    );
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1500);
  });
});
