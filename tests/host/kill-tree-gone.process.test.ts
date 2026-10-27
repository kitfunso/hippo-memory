// killTree on a process that is already gone, and the warnings its failures raise, with the OS calls stubbed.
import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../src/base/util/log.js';
import { killTree } from '../../src/host/kill-tree.js';

const WIN32 = process.platform === 'win32';

/** A taskkill stand-in that closes with `code` at once. */
const fakeKiller = (code: number) => (): ChildProcess => {
  const killer = new ChildProcess();
  setImmediate(() => killer.emit('close', code));
  return killer;
};

class HungKiller extends ChildProcess {
  override kill(): boolean {
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.runIf(WIN32)('killTree through taskkill', () => {
  it('stays quiet when taskkill says there is no such process (128)', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await expect(killTree(4_000_000, fakeKiller(128))).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the exit code when taskkill fails', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await killTree(4_000_000, fakeKiller(1));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('exited with 1');
  });
});

describe.runIf(WIN32)('killTree when taskkill hangs', () => {
  it('warns once on the timeout, and not again when the stopped taskkill closes', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // A bare ChildProcess has no handle, so its kill() would emit an unrelated EBADF error.
    const killer = new HungKiller();
    const done = killTree(4_000_000, () => killer);
    await vi.advanceTimersByTimeAsync(10_000);
    killer.emit('close', null);
    await done;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not finish');
  });
});

describe.skipIf(WIN32)('killTree through signals', () => {
  it('treats a process that is already gone (ESRCH) as ended, without a warning', async () => {
    const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw gone;
    });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await expect(killTree(4_000_000)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when new descendants keep appearing through every round', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let round = 0;
    // Each snapshot shows one more child of the root, so no round ever settles.
    const snapshot = async (): Promise<Map<number, number>> => {
      round++;
      const children = new Map<number, number>();
      for (let i = 0; i < round; i++) children.set(100 + i, 1);
      return children;
    };
    await killTree(1, undefined, snapshot);
    expect(round).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('after 5 rounds');
  });
});
