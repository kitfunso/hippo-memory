// A request scope owns one handle per store; code that outlives the scope, or runs beside it, never gets or closes that handle.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openHippoDb,
  closeHippoDb,
  noteStoreBusy,
  RequestStores,
  runWithRequestStores,
  currentRequestStores,
  outsideRequestStores,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';

let root: string;

beforeEach(() => {
  ({ root } = makeStore('request-stores'));
});

const busyTimeout = (db: DatabaseSyncLike): number =>
  Number((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout);

describe('runWithRequestStores', () => {
  it('work that outlives its scope gets a connection of its own, which closeHippoDb closes', async () => {
    let late: Promise<DatabaseSyncLike> | undefined;
    // Released only once the scope has closed, so the late open runs after it in the scope's async context.
    let release = (): void => undefined;
    const scopeClosed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scoped = await runWithRequestStores(
      () => {
        late = scopeClosed.then(() => openHippoDb(root));
        return openHippoDb(root);
      },
      { busyWaitMs: 250 },
    );
    expect(scoped.isOpen).toBe(false);
    release();
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
    const [held, scoped] = await runWithRequestStores(() => [
      outsideRequestStores(() => openHippoDb(root)),
      openHippoDb(root),
    ]);
    try {
      expect(held === scoped).toBe(false);
      expect(scoped.isOpen).toBe(false);
      expect(held.isOpen).toBe(true);
    } finally {
      closeHippoDb(held);
    }
  });

  it("interleaved scopes never share or close each other's handles", async () => {
    let first: DatabaseSyncLike | undefined;
    // Scope a stays open until b has opened its own handle beside it.
    let release = (): void => undefined;
    const bOpened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = runWithRequestStores(async () => {
      first = openHippoDb(root);
      await bOpened;
      expect(openHippoDb(root)).toBe(first);
    });
    const b = runWithRequestStores(async () => {
      const own = openHippoDb(root);
      expect(own === first).toBe(false);
      expect(first?.isOpen).toBe(true);
      release();
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
      await runWithRequestStores(
        () => {
          expect(currentRequestStores()).toBe(outer);
          expect(openHippoDb(root)).toBe(db);
        },
        { busyWaitMs: 1 },
      );
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
    const waits = async (failFastWhenBusy: boolean) =>
      runWithRequestStores(
        () => {
          const db = openHippoDb(root);
          noteStoreBusy('test write skipped');
          return busyTimeout(db);
        },
        { busyWaitMs: 1000, failFastWhenBusy },
      );
    expect(await waits(true)).toBe(0);
    expect(await waits(false)).toBe(1000);
  });
});

describe('RequestStores.close', () => {
  it('closes every handle when one refuses, logs each failure with its class, and rethrows the first', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { root: other } = makeStore('request-stores-second');
      const stores = new RequestStores();
      const first = stores.get(root);
      const second = stores.get(other);
      const realClose = first.close.bind(first);
      first.close = () => {
        realClose();
        throw new Error('first would not close');
      };
      expect(() => stores.close()).toThrow('first would not close');
      expect(second.isOpen).toBe(false);
      expect(stores.closed).toBe(true);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('errorClass=Error');
    } finally {
      stderr.mockRestore();
    }
  });
});
