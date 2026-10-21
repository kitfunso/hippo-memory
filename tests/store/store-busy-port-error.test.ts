// A held lock leaves the SQLite adapter as the port's StoreBusyError, with the driver's error as its cause and its text
// kept, wherever it escapes: a served store call, a request scope, a hook scope and a batch.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, isSqliteBusy, openHippoDb, runWithRequestStores } from '../../src/db/index.js';
import { isStoreBusy, StoreBusyError } from '../../src/store/port.js';
import { portError } from '../../src/store/sqlite/port-errors.js';
import { runSqliteBatch, runSqliteHookRequest, runSqliteRequest } from '../../src/store/sqlite/request-scope.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

const root = makeRoot('busy-port-error');
const SNAPSHOT = { task: 'ship', summary: 'half done', next_step: 'merge', session_id: 's1' };

/** Runs `fn` while another connection holds the write lock. */
async function whileHeld<T>(fn: () => Promise<T>): Promise<T> {
  const holder = openHippoDb(root);
  holder.exec('BEGIN IMMEDIATE');
  try {
    return await fn();
  } finally {
    holder.exec('ROLLBACK');
    closeHippoDb(holder);
  }
}

/** A genuine busy error from node:sqlite: a second handle asks for the lock the first holds, with no wait. */
function driverBusyError(): Error {
  const holder = openHippoDb(root);
  const other = openHippoDb(root);
  holder.exec('BEGIN IMMEDIATE');
  try {
    other.exec('PRAGMA busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE');
  } catch (err) {
    if (err instanceof Error && isSqliteBusy(err)) return err;
    throw err;
  } finally {
    holder.exec('ROLLBACK');
    closeHippoDb(holder);
    closeHippoDb(other);
  }
  throw new Error('expected a busy error from the second handle');
}

async function rejection<T>(work: Promise<T>): Promise<Error> {
  try {
    await work;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('a busy hippo.db in the port terms', () => {
  it('a served store call rejects with StoreBusyError, the driver text and the driver error as its cause', async () => {
    const store = sqliteStore(root);
    const err = await whileHeld(() =>
      rejection(runWithRequestStores(() => store.sessions.saveSnapshot('default', SNAPSHOT, null), { busyWaitMs: 50 })),
    );
    expect(err).toBeInstanceOf(StoreBusyError);
    expect(err).toMatchObject({ message: 'database is locked' });
    expect(isSqliteBusy(err.cause)).toBe(true);
  });

  it('a request scope and a batch throw a busy code that escapes them as StoreBusyError', async () => {
    const raw = driverBusyError();
    const scoped = await rejection(
      runSqliteRequest(() => {
        throw raw;
      }, 'cli'),
    );
    expect(scoped).toBeInstanceOf(StoreBusyError);
    expect(scoped.cause).toBe(raw);
    expect(() =>
      runSqliteBatch(() => {
        throw raw;
      }),
    ).toThrow(StoreBusyError);
  });

  it('a hook scope skips its work on a busy code and answers undefined', async () => {
    const raw = driverBusyError();
    await expect(
      runSqliteHookRequest(() => {
        throw raw;
      }),
    ).resolves.toBeUndefined();
  });

  it('the port knows only its own error, and any other error leaves the adapter as thrown', () => {
    const raw = driverBusyError();
    expect(isStoreBusy(raw)).toBe(false);
    expect(isStoreBusy(portError(raw))).toBe(true);
    const other = new Error('no such table: x');
    expect(portError(other)).toBe(other);
  });
});
