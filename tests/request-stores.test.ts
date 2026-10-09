// A request scope owns one handle per store; code that outlives the scope, or runs beside it, never gets or closes that handle.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openHippoDb, closeHippoDb, noteStoreBusy, runWithRequestStores, currentRequestStores, outsideRequestStores, type DatabaseSyncLike } from '../src/db.js';
import { initStore } from '../src/store/open.js';

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-request-stores-'));
  root = path.join(tmp, '.hippo');
  initStore(root);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const busyTimeout = (db: DatabaseSyncLike): number => Number(db.prepare('PRAGMA busy_timeout').get<{ timeout: number }>().timeout);

describe('runWithRequestStores', () => {
  it('a timer that outlives its scope gets a connection of its own, which closeHippoDb closes', async () => {
    let late: Promise<DatabaseSyncLike> | undefined;
    const scoped = await runWithRequestStores(() => {
      late = sleep(20).then(() => openHippoDb(root));
      return openHippoDb(root);
    }, { busyWaitMs: 250 });
    expect(scoped.isOpen).toBe(false);
    const db = await late!;
    try {
      // Identity as a boolean: the matcher would format the closed handle, which throws.
      expect(db === scoped).toBe(false);
      expect(db.isOpen).toBe(true);
      expect(busyTimeout(db)).toBe(250);
    } finally {
      closeHippoDb(db);
    }
    expect(db.isOpen).toBe(false);
  });

  it('an open outside the scope survives the scope closing', async () => {
    const [held, scoped] = await runWithRequestStores(() => [outsideRequestStores(() => openHippoDb(root)), openHippoDb(root)]);
    try {
      expect(held === scoped).toBe(false);
      expect(scoped.isOpen).toBe(false);
      expect(held.isOpen).toBe(true);
    } finally {
      closeHippoDb(held);
    }
  });

  it('interleaved scopes never share or close each other\'s handles', async () => {
    let first: DatabaseSyncLike | undefined;
    const a = runWithRequestStores(async () => {
      first = openHippoDb(root);
      await sleep(10);
      expect(openHippoDb(root)).toBe(first);
    });
    const b = runWithRequestStores(async () => {
      const own = openHippoDb(root);
      expect(own === first).toBe(false);
      await a;
      expect(first?.isOpen).toBe(false);
      expect(own.isOpen).toBe(true);
      expect(openHippoDb(root) === own).toBe(true);
    });
    await b;
  });

  it('a nested scope joins the open one', async () => {
    await runWithRequestStores(async () => {
      const outer = currentRequestStores();
      const db = openHippoDb(root);
      await runWithRequestStores(() => {
        expect(currentRequestStores()).toBe(outer);
        expect(openHippoDb(root)).toBe(db);
      }, { busyWaitMs: 1 });
      expect(db.isOpen).toBe(true);
    });
  });

  it('installs one exit listener however many scopes open stores', async () => {
    await runWithRequestStores(() => openHippoDb(root));
    const before = process.listenerCount('exit');
    for (let i = 0; i < 5; i++) await runWithRequestStores(() => openHippoDb(root));
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('a busy store drops the lock wait only in a fail-fast scope', async () => {
    const waits = async (failFastWhenBusy: boolean) => runWithRequestStores(() => {
      const db = openHippoDb(root);
      noteStoreBusy('test write skipped');
      return busyTimeout(db);
    }, { busyWaitMs: 1000, failFastWhenBusy });
    expect(await waits(true)).toBe(0);
    expect(await waits(false)).toBe(1000);
  });
});
