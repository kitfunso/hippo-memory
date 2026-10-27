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

afterEach(() => vi.restoreAllMocks());

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
});
