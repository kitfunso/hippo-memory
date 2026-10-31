// Z0 runner git helper: a loose object held by antivirus is retried and counted; any other failure throws at once.
import { describe, it, expect } from 'vitest';
import { retryObjectLock, objectLockRetries } from '../scripts/token-eval/exec.mjs';

const lockError = (): Error => Object.assign(new Error('Command failed: git add -A'), {
  status: 128,
  stderr: 'error: unable to write file C:\\w\\task one\\.git/objects/ed/5761b76fa3e3108be99db67d67ad64be345543: Permission denied\nfatal: adding files failed\n',
});
const NO_WAIT = [0, 0, 0, 0];

describe('retryObjectLock', () => {
  it('reruns past a locked loose object and counts each retry', () => {
    const before = objectLockRetries.count;
    let calls = 0;
    const out = retryObjectLock(() => {
      calls++;
      if (calls < 3) throw lockError();
      return 'tree';
    }, NO_WAIT);
    expect(out).toBe('tree');
    expect(calls).toBe(3);
    expect(objectLockRetries.count - before).toBe(2);
  });

  it('throws any other git failure on the first call', () => {
    let calls = 0;
    const other = Object.assign(new Error('Command failed: git add -A'), { status: 128, stderr: "fatal: pathspec 'x' did not match any files\n" });
    expect(() => retryObjectLock(() => {
      calls++;
      throw other;
    }, NO_WAIT)).toThrow(other);
    expect(calls).toBe(1);
  });

  it('gives up after the last wait and throws the lock error', () => {
    let calls = 0;
    expect(() => retryObjectLock(() => {
      calls++;
      throw lockError();
    }, NO_WAIT)).toThrow(/git add -A/);
    expect(calls).toBe(NO_WAIT.length + 1);
  });
});
