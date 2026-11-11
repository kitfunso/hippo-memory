// The z0 batch teardown's helpers: the Z0_BATCH_KEEP folder check, and killTree's report of a taskkill that failed.
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keepDir, killTree } from './fixtures/z0-batch/harness.js';

const win = process.platform === 'win32';
const started: ChildProcess[] = [];
const exited = (child: ChildProcess) => new Promise<void>((done) => {
  if (child.exitCode !== null || child.signalCode !== null) done();
  else child.once('exit', () => done());
});

afterEach(async () => {
  for (const child of started.splice(0)) {
    child.kill();
    await exited(child);
  }
});

describe('Z0_BATCH_KEEP', () => {
  const realTmp = process.env.HIPPO_TEST_REAL_TMP ?? '';

  it('is unset or empty: nothing is kept', () => {
    expect(keepDir(undefined)).toBeUndefined();
    expect(keepDir('')).toBeUndefined();
  });

  it('a folder under the real temp folder and outside the run\'s temp root is kept', () => {
    expect(realTmp).not.toBe('');
    expect(keepDir(join(realTmp, 'z0-keep-probe'))?.toLowerCase()).toBe(resolve(realTmp, 'z0-keep-probe').toLowerCase());
  });

  it('a relative folder, one outside the real temp folder, under C:/z0-runs, inside the run\'s temp root, or the temp folder itself is refused, naming it', () => {
    for (const keep of ['relative-keep', join(parse(realTmp).root, 'z0-keep-probe'), 'C:/z0-runs/keep', join(tmpdir(), 'keep'), realTmp]) {
      expect(() => keepDir(keep), keep).toThrow(/^Z0_BATCH_KEEP=.* is refused/);
    }
  });
});

describe.skipIf(!win)('killTree', () => {
  const live = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
    started.push(child);
    return new Promise<ChildProcess>((done) => child.once('spawn', () => done(child)));
  };
  // A taskkill stand-in that answers as taskkill does and kills nothing, so the test's own handle ends the child.
  const answers = (status: number, stderr: string) => () => ({ pid: 0, output: [], stdout: '', stderr, status, signal: null });

  it('throws on a taskkill failure other than the process being gone', async () => {
    const child = await live();
    expect(() => killTree(child, answers(1, 'ERROR: The process with PID 1 could not be terminated.\r\nReason: Access is denied.\r\n'))).toThrow(/Access is denied/);
  });

  it('takes a process that exited during the kill as done', async () => {
    const child = await live();
    expect(() => killTree(child, answers(128, `ERROR: The process "${child.pid}" not found.\r\n`))).not.toThrow();
    expect(() => killTree(child, answers(255, `ERROR: The process with PID 1 (child process of PID ${child.pid}) could not be terminated.\r\nReason: There is no running instance of the task.\r\n`))).not.toThrow();
  });

  it('ends a live child it spawned through the real taskkill', async () => {
    const child = await live();
    killTree(child);
    await Promise.race([exited(child), new Promise((done) => setTimeout(done, 15_000))]);
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
  });
});
