// A root hands HIPPO_BUSY_WAIT_MS to setDefaultBusyWaitMs; every open that names no wait reads it then.
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => setDefaultBusyWaitMs(5000));

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

  it.each([0, -1, 1.5])('rejects %s, naming it, and keeps the wait it had', (ms) => {
    expect(() => setDefaultBusyWaitMs(ms)).toThrow(new RegExp(`positive whole number of ms, not ${ms}$`));
    expect(defaultBusyWaitMs()).toBe(5000);
  });
});
