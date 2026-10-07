// The session-end worker can fail to start after spawn returns; that failure must be logged, never crash the hook.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

let dir: string;

afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('hippo session-end worker spawn', () => {
  it('logs a worker that fails to start and still exits 0', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-spawn-error-'));
    // A Node binary gone from disk (upgraded mid-session) fails with ENOENT, which spawn reports as an 'error' event.
    const preload = path.join(dir, 'missing-node.mjs');
    fs.writeFileSync(preload, `process.execPath = ${JSON.stringify(path.join(dir, 'no-such-node'))};\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: path.join(dir, 'global'), HOME: dir, USERPROFILE: dir, HIPPO_LOG: 'warn' };
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HIPPO_JS, 'session-end'], {
      cwd: dir, env, input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain('the worker did not start');
    expect(run.stderr).toContain('ENOENT');
  });
});
