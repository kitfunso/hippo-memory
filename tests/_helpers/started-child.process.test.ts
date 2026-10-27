import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pidAlive } from '../../src/host/pid-alive.js';
import { endOfFile, makeRoot, removeWhenStopped, trackLive } from './make-root.js';
import { hippoRun } from './spawn-hippo.js';
import { startNode } from './started-child.js';
import { waitFor } from './wait-for.js';

const ECHO_LINES = `process.stdin.setEncoding('utf8'); process.stdin.on('data', (t) => process.stdout.write(t));`;
const PARENT_OF_GRANDCHILD = `
const { spawn } = require('node:child_process');
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
process.stdout.write('grandchild ' + grand.pid + '\\n');
setInterval(() => {}, 1000);
`;

describe('startNode', () => {
  it('a second line() waits for a line after the first match', async () => {
    const child = startNode(['-e', ECHO_LINES]);
    child.send('tick 1\n');
    await child.line(/^tick/, 'first tick');
    const second = child.line(/^tick (\d)/, 'second tick');
    child.send('tick 2\n');
    expect((await second)[1]).toBe('2');
  });

  it('two waits for different lines each see their own line, in either order', async () => {
    const child = startNode(['-e', ECHO_LINES]);
    const second = child.line(/^second$/, 'the second line');
    const first = child.line(/^first$/, 'the first line');
    child.send('first\nsecond\n');
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('reads lines from stdout only', async () => {
    const child = startNode([
      '-e',
      `process.stderr.write('ready\\n'); setTimeout(() => process.stdout.write('ready\\n'), 200);`,
    ]);
    const started = Date.now();
    await child.line(/^ready$/, 'the stdout ready line');
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('rejects at its deadline naming what and the output so far', async () => {
    const child = startNode(['-e', `process.stdout.write('booting\\n'); setInterval(() => {}, 1000);`]);
    // The deadline starts once the child has printed, so a slow start cannot empty the output it names.
    await child.line(/^booting$/, 'the booting line');
    await expect(child.line(/^ready/, 'the ready line', 3_000)).rejects.toThrow(
      /the ready line not seen within 3000 ms.*still running.*booting/s,
    );
  });

  it("each call starts its own deadline, so an idle 'file' child still gets a full wait", async () => {
    const answerLate = `process.stdin.on('data', () => setTimeout(() => process.stdout.write('late\\n'), 100)); process.stdout.write('listening\\n');`;
    const child = startNode(['-e', answerLate], { lifetime: 'file', deadlineMs: 3_000 });
    await child.line(/^listening$/, 'the stdin listener');
    // Idle past the whole deadline: a deadline counted from the spawn has nothing left for the answer's 100 ms.
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const late = child.line(/^late/, 'the late line');
    child.send('go\n');
    await expect(late).resolves.toBeTruthy();
    await child.stop();
  });

  it('rejects at once when the child exits without the line', async () => {
    const child = startNode(['-e', `process.stdout.write('bye\\n'); process.exit(3)`]);
    // The deadline's message says "within"; this one says the child exited, so the exit ended the wait.
    await expect(child.line(/^ready/, 'the ready line')).rejects.toThrow(
      /^the ready line not seen: child \d+ exited with 3.*bye/s,
    );
  });

  it('stop() leaves neither the child nor its grandchild running', async () => {
    const child = startNode(['-e', PARENT_OF_GRANDCHILD]);
    const grand = Number((await child.line(/^grandchild (\d+)/, 'the grandchild pid'))[1]);
    expect(pidAlive(grand)).toBe(true);
    await child.stop();
    expect(pidAlive(child.pid)).toBe(false);
    await waitFor(() => !pidAlive(grand), { what: `grandchild ${grand} gone`, timeoutMs: 2_000 });
  });

  it('a graceful stop also leaves no grandchild running', async () => {
    const child = startNode(['-e', PARENT_OF_GRANDCHILD]);
    const grand = Number((await child.line(/^grandchild (\d+)/, 'the grandchild pid'))[1]);
    await child.stop({ graceful: true });
    await waitFor(() => !pidAlive(grand), { what: `grandchild ${grand} gone`, timeoutMs: 2_000 });
  });

  it('stop() resolves only once the exit is seen', async () => {
    const child = startNode(['-e', 'setInterval(() => {}, 1000)']);
    await child.stop();
    expect(child.running()).toBe(false);
    await expect(child.exited(1)).resolves.toMatchObject({ code: expect.anything() });
  });

  it("the file's end stops 'file' children before it removes the folders made for the file", async () => {
    const dir = makeRoot('started-child-file');
    const child = startNode(['-e', `process.stdout.write('up\\n'); setInterval(() => {}, 1000);`], {
      cwd: dir,
      lifetime: 'file',
    });
    await child.line(/^up$/, 'the file child');
    await endOfFile();
    expect(child.running()).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('gives a spawn error to the caller, with no uncaught error in the worker', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const child = startNode(['-e', ''], { cwd: join(tmpdir(), 'hippo-started-child-missing', 'cwd') });
      await expect(child.exited()).rejects.toMatchObject({ code: 'ENOENT' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it('removeWhenStopped stops a tracked child while its folder is still there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hippo-started-child-'));
    let sawFolder: boolean | null = null;
    trackLive({
      lifetime: 'test',
      stop: async () => {
        sawFolder = existsSync(dir);
      },
    });
    await removeWhenStopped(dir);
    expect(sawFolder).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('a deadline over the hang guard throws RangeError everywhere', async () => {
    expect(() => startNode(['-e', ''], { deadlineMs: 45_001, reason: 'r' })).toThrow(RangeError);
    const child = startNode(['-e', ECHO_LINES]);
    expect(() => child.line(/x/, 'x', 45_001)).toThrow(RangeError);
    await expect(waitFor(() => true, { timeoutMs: 45_001, reason: 'r' })).rejects.toThrow(RangeError);
    expect(() => hippoRun(['--version'], { timeout: 45_001 })).toThrow(RangeError);
  });

  it('a deadline over the event deadline needs a reason', async () => {
    expect(() => startNode(['-e', ''], { deadlineMs: 10_001 })).toThrow(/needs a reason/);
    expect(() => hippoRun(['--version'], { timeout: 10_001 })).toThrow(/needs a reason/);
    await expect(waitFor(() => true, { timeoutMs: 10_001 })).rejects.toThrow(/needs a reason/);
    await expect(waitFor(() => true, { timeoutMs: 10_001, reason: 'measured 4 s' })).resolves.toBeUndefined();
  });
});
