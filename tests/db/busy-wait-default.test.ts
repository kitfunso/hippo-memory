// A root hands HIPPO_BUSY_WAIT_MS to setDefaultBusyWaitMs; every open that names no wait reads it then.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envBusyWaitMs } from '../../src/base/util/env.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { defaultBusyWaitMs, setDefaultBusyWaitMs } from '../../src/db/busy.js';
import { makeRoot } from '../_helpers/make-root.js';

const busyTimeout = (root: string): number => {
  const db = openHippoDb(root);
  try {
    // SAFETY: PRAGMA busy_timeout returns one row with a numeric `timeout`.
    return (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  } finally {
    closeHippoDb(db);
  }
};

afterEach(() => {
  setDefaultBusyWaitMs(5000);
  vi.unstubAllEnvs();
});

describe('setDefaultBusyWaitMs', () => {
  it('is 5000 ms until a root sets it', () => {
    expect(defaultBusyWaitMs()).toBe(5000);
    expect(busyTimeout(makeRoot('busy-default'))).toBe(5000);
  });

  it('sets the busy_timeout of a later open that names no wait', () => {
    setDefaultBusyWaitMs(250);
    expect(defaultBusyWaitMs()).toBe(250);
    expect(busyTimeout(makeRoot('busy-set'))).toBe(250);
  });

  it.each(['3000000000', '0', 'abc'])('reads HIPPO_BUSY_WAIT_MS=%s as unset, so a root keeps 5000', (value) => {
    vi.stubEnv('HIPPO_BUSY_WAIT_MS', value);
    expect(envBusyWaitMs()).toBeUndefined();
  });

  it('reads HIPPO_BUSY_WAIT_MS up to the cap', () => {
    vi.stubEnv('HIPPO_BUSY_WAIT_MS', '2147483647');
    expect(envBusyWaitMs()).toBe(2147483647);
  });

  it.each([0, -1, 1.5, 2 ** 31, 1e30])('rejects %s, naming it, and keeps the wait it had', (ms) => {
    expect(() => setDefaultBusyWaitMs(ms)).toThrow(`a whole number of ms from 1 to 2147483647, not ${ms}`);
    expect(defaultBusyWaitMs()).toBe(5000);
  });
});
