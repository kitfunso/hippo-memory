// cmdSessionEndWorker used to call cmdSleep without awaiting it inside its
// try/catch, so a sleep rejection became an unhandled promise rejection
// that could crash the process before capture/close ran.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

function withScratchEnv(dir: string) {
  return { ...process.env, HIPPO_HOME: dir, HOME: dir, USERPROFILE: dir };
}

let dir: string;

afterEach(() => {
  try {
    removeAfterRequest(dir);
  } catch {
    // best-effort cleanup only
  }
});

describe('__session-end-worker awaits cmdSleep before finishing', () => {
  it('a sleep failure is caught (not an unhandled rejection) and the close step still runs after it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hippo-worker-await-sleep-'));
    const env = withScratchEnv(dir);

    // In process, so coverage sees the worker; a rejection it failed to catch would still fail the run.
    const init = await runCliAs(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: dir, env });
    expect(init.status).toBe(0);

    // Corrupt hippo.db so cmdSleepCore's DB open throws synchronously and
    // fast — deterministic, and independent of any lock-timing behavior.
    writeFileSync(join(dir, 'hippo.db'), 'not a sqlite database, deliberately corrupted for this test');

    const logFile = join(dir, 'worker-await.log');
    const result = await runCliAs(['__session-end-worker', '--log-file', logFile], {
      cwd: dir,
      env,
      input: JSON.stringify({ hook_event_name: 'SessionEnd' }),
    });

    // Pre-fix, an unhandled rejection kills the process non-zero; the fix exits clean.
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Unhandled');

    const log: string = require('node:fs').readFileSync(logFile, 'utf8');
    const sleepFailedAt = log.indexOf('sleep failed:');
    const skipCloseAt = log.indexOf('skip: no session_id');
    expect(sleepFailedAt).toBeGreaterThan(-1);
    expect(skipCloseAt).toBeGreaterThan(-1);
    // Order proves capture + the snapshot-close step ran AFTER the awaited
    // sleep rejected, not raced by a process killed mid-write.
    expect(skipCloseAt).toBeGreaterThan(sleepFailedAt);
  });
});
