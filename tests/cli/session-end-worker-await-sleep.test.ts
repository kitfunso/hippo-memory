import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { removeDir } from '../_helpers/remove-dir.js';

function withScratchEnv(dir: string) {
  return { ...process.env, HIPPO_HOME: dir, HOME: dir, USERPROFILE: dir };
}

let dir: string;

afterEach(() => {
  try {
    removeDir(dir);
  } catch {
    // best-effort cleanup only
  }
});

describe('__session-end-worker awaits handleSleep before finishing', () => {
  it('a sleep failure is caught (not an unhandled rejection) and the close step still runs after it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hippo-worker-await-sleep-'));
    const env = withScratchEnv(dir);

    const init = await runCliAs(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: dir, env });
    expect(init.status).toBe(0);

    writeFileSync(join(dir, 'hippo.db'), 'not a sqlite database, deliberately corrupted for this test');

    const logFile = join(dir, 'worker-await.log');
    const result = await runCliAs(['__session-end-worker', '--log-file', logFile], {
      cwd: dir,
      env,
      input: JSON.stringify({ hook_event_name: 'SessionEnd' }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Unhandled');

    const log: string = require('node:fs').readFileSync(logFile, 'utf8');
    const sleepFailedAt = log.indexOf('sleep failed:');
    const skipCloseAt = log.indexOf('skip: no session_id');
    expect(sleepFailedAt).toBeGreaterThan(-1);
    expect(skipCloseAt).toBeGreaterThan(-1);
    expect(skipCloseAt).toBeGreaterThan(sleepFailedAt);
  });
});
