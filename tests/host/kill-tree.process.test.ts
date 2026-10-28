// A timeout or a kill takes the whole tree: the child's own children die with it.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree } from '../../src/host/kill-tree.js';
import { errorCode } from '../../src/base/util/log.js';
import { pidAlive } from '../../src/host/pid-alive.js';
import { runWatched, RunWatchedTimeoutError } from '../../src/surface/cli/run-watched.js';
import { startNode } from '../_helpers/started-child.js';
import { waitFor } from '../_helpers/wait-for.js';

const made: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-kill-tree-'));
  made.push(dir);
  return dir;
};
const strays: number[] = [];

const seenGone = new Set<number>();

afterEach(() => {
  for (const pid of strays.splice(0)) {
    if (seenGone.has(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      // ESRCH: already gone. EPERM: a reused pid that is not ours.
      if (errorCode(err) !== 'ESRCH' && errorCode(err) !== 'EPERM') throw err;
    }
  }
  seenGone.clear();
});
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A program that starts a grandchild, prints its own pid and the grandchild's (also to `pidFile` if given), then idles. */
const PARENT_SCRIPT = (pidFile?: string): string => `
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  const pids = process.pid + ' ' + grandchild.pid;
  ${pidFile === undefined ? '' : `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, pids);`}
  process.stdout.write('pids ' + pids + '\\n');
  setInterval(() => {}, 1 << 30);
`;

async function grandchildPid(pidFile: string): Promise<number> {
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', { what: 'the grandchild pid file' });
  const [parent, grandchild] = readFileSync(pidFile, 'utf8').split(' ').map(Number);
  strays.push(parent, grandchild);
  return grandchild;
}

const gone = async (pid: number): Promise<void> => {
  await waitFor(() => !pidAlive(pid), { what: `process ${pid} gone` });
  seenGone.add(pid);
};

describe('killTree', () => {
  it('kills the child and the grandchild it started', async () => {
    const child = startNode(['-e', PARENT_SCRIPT()]);
    const [, grandchild] = (await child.line(/^pids \d+ (\d+)$/, 'the grandchild pid')).map(Number);
    strays.push(grandchild);
    await killTree(child.pid);
    await gone(child.pid);
    await gone(grandchild);
  });
});

describe('runWatched past its deadline', () => {
  it('does not kill a pid after its child exited, and still settles', async () => {
    // The child exits at once; a detached grandchild keeps stderr open past the deadline.
    const script = `const gc = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] }); process.stderr.write('gc ' + gc.pid); gc.unref();`;
    const killed: number[] = [];
    const outcome = await runWatched([process.execPath, '-e', script], 3000, async (pid) => {
      killed.push(pid);
    }).catch((e: Error) => e);
    expect(outcome).toBeInstanceOf(RunWatchedTimeoutError);
    const stderr = outcome instanceof RunWatchedTimeoutError ? outcome.stderr : String(outcome);
    const marker = /gc (\d+)/.exec(stderr);
    const gcPid = marker === null ? 0 : Number(marker[1]);
    if (!(gcPid > 0)) throw new Error(`no grandchild pid above 0 in stderr: ${stderr}`);
    strays.push(gcPid);
    expect(killed).toEqual([]);
  });

  it('rejects with the typed error and takes the grandchild down too', async () => {
    const pidFile = join(scratch(), 'grandchild.pid');
    const timedOut = runWatched([process.execPath, '-e', PARENT_SCRIPT(pidFile)], 3_000).catch((e: Error) => e);
    const grandchild = await grandchildPid(pidFile);
    expect(await timedOut).toBeInstanceOf(RunWatchedTimeoutError);
    await gone(grandchild);
  });

  it.runIf(process.platform === 'win32')('does the same through a .cmd shim, where cmd.exe is the child', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'grandchild.pid');
    const script = join(dir, 'parent.js');
    writeFileSync(script, PARENT_SCRIPT(pidFile));
    const shim = join(dir, 'shim.cmd');
    writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    const timedOut = runWatched([shim], 3_000).catch((e: Error) => e);
    const grandchild = await grandchildPid(pidFile);
    expect(await timedOut).toBeInstanceOf(RunWatchedTimeoutError);
    await gone(grandchild);
  });
});
