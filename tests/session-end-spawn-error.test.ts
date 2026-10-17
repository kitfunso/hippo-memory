// The session-end worker can fail to start after spawn returns; that failure must be logged, never crash the hook.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCodexWrapper } from '../src/hooks/codex-wrapper.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-spawn-error-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** Runs hippo with a Node binary gone from disk (upgraded mid-session): every worker spawn fails with ENOENT, reported as an 'error' event. */
function runWithMissingNode(args: readonly string[], logLevel: string, input?: string): SpawnSyncReturns<string> {
  const preload = path.join(dir, 'missing-node.mjs');
  fs.writeFileSync(preload, `process.execPath = ${JSON.stringify(path.join(dir, 'no-such-node'))};\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HIPPO_HOME: path.join(dir, 'global'), HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, '.codex'),
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_LOG: logLevel,
  };
  return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HIPPO_JS, ...args], { cwd: dir, env, input, encoding: 'utf8' });
}

describe('hippo session-end worker spawn', () => {
  it('logs a worker that fails to start and still exits 0', () => {
    const run = runWithMissingNode(['session-end'], 'warn', JSON.stringify({ session_id: 's1' }));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain('the worker did not start');
    expect(run.stderr).toContain('ENOENT');
  });
});

/** Installs the wrapper under `dir` over a launcher that runs the real Node, since codex-run starts only what the
 * installer recorded. */
function installNodeAsCodex(bin: string): void {
  fs.mkdirSync(bin, { recursive: true });
  const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const launcher = path.join(bin, process.platform === 'win32' ? 'codex.ps1' : 'codex');
  fs.writeFileSync(launcher, process.platform === 'win32'
    ? `& ${ps(process.execPath)} @args\r\nexit $LASTEXITCODE\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  fs.chmodSync(launcher, 0o755);
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
  try {
    installCodexWrapper(launcher);
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('hippo codex-run worker spawn', () => {
  it('runs the session-end work inline when the worker fails to start, and exits like Codex did', () => {
    const logFile = path.join(dir, '.hippo', 'logs', 'codex-sleep.log');
    const fakeCodex = path.join(dir, 'fake-codex.mjs');
    fs.writeFileSync(fakeCodex, 'process.exit(7);\n');
    // The real Node stands in for Codex, so only the worker spawn (through process.execPath) fails.
    installNodeAsCodex(path.join(dir, 'real-bin'));

    const run = runWithMissingNode(['codex-run', '--', fakeCodex], 'debug');

    expect(run.stderr).not.toContain("Unhandled 'error' event");
    expect(run.status, run.stderr).toBe(7);
    expect(run.stderr).toContain('the session-end worker did not spawn, running inline');
    expect(run.stderr).toContain('ENOENT');
    // No Node exists for a detached worker here, so this line can only come from the inline run.
    expect(fs.readFileSync(logFile, 'utf8')).toContain('skip: no hippo store');
  });
});
