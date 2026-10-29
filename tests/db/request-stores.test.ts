// A request session owns one handle per store; code that outlives the session, or runs beside it, never gets or closes
// that handle.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openHippoDb,
  closeHippoDb,
  noteStoreBusy,
  RequestStores,
  withSharedStoreHandles,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { StoreRuntime } from '../../src/db/store-runtime.js';
import { grantFor } from '../../src/store/sqlite/runtime/grant.js';

let root: string;

beforeEach(() => {
  ({ root } = makeStore('request-stores'));
});

const busyTimeout = (db: DatabaseSyncLike): number =>
  Number((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout);

/** An open on `session`, as a store built with it makes. */
const openIn = (session: RequestStores): DatabaseSyncLike => grantFor({ session }).open(root);

describe('withSharedStoreHandles', () => {
  it('work that outlives its session gets a connection of its own, which closeHippoDb closes', async () => {
    let late: Promise<DatabaseSyncLike> | undefined;
    // Released only once the session has closed, so the late open runs after it.
    let release = (): void => undefined;
    const sessionClosed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scoped = await withSharedStoreHandles(
      (session) => {
        late = sessionClosed.then(() => openIn(session));
        return openIn(session);
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

  it('an open without the session survives the session closing', async () => {
    const [held, scoped] = await withSharedStoreHandles((session) => [openHippoDb(root), openIn(session)]);
    try {
      expect(held === scoped).toBe(false);
      expect(scoped.isOpen).toBe(false);
      expect(held.isOpen).toBe(true);
    } finally {
      closeHippoDb(held);
    }
  });

  it("interleaved sessions never share or close each other's handles", async () => {
    let first: DatabaseSyncLike | undefined;
    // Session a stays open until b has opened its own handle beside it.
    let release = (): void => undefined;
    const bOpened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = withSharedStoreHandles(async (session) => {
      first = openIn(session);
      await bOpened;
      expect(openIn(session)).toBe(first);
    });
    const b = withSharedStoreHandles(async (session) => {
      const own = openIn(session);
      expect(own === first).toBe(false);
      expect(first?.isOpen).toBe(true);
      release();
      await a;
      expect(first?.isOpen).toBe(false);
      expect(own.isOpen).toBe(true);
      expect(openIn(session) === own).toBe(true);
    });
    await b;
  });

  it('installs no process listener however many sessions open stores', async () => {
    const before = process.listenerCount('exit');
    for (let i = 0; i < 5; i++) await withSharedStoreHandles(openIn);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it("with a runtime, a closed session's handle serves the next session, and dispose closes it", async () => {
    const runtime = new StoreRuntime();
    const first = await withSharedStoreHandles(openIn, { runtime });
    expect(first.isOpen).toBe(true);
    const second = await withSharedStoreHandles(openIn, { runtime });
    expect(second).toBe(first);
    runtime.dispose();
    expect(first.isOpen).toBe(false);
  });

  it('dispose closes a session still open when the process leaves', async () => {
    const runtime = new StoreRuntime();
    let held: DatabaseSyncLike | undefined;
    let release = (): void => undefined;
    const done = withSharedStoreHandles(
      async (session) => {
        held = openIn(session);
        await new Promise<void>((resolve) => (release = resolve));
      },
      { runtime },
    );
    await vi.waitFor(() => expect(held).toBeDefined());
    runtime.dispose();
    expect(held!.isOpen).toBe(false);
    release();
    await done;
  });

  it('without a runtime a closed session closes its handle', async () => {
    const db = await withSharedStoreHandles(openIn);
    expect(db.isOpen).toBe(false);
  });

  it('a busy store drops the lock wait only in a fail-fast session', async () => {
    const waits = async (failFastWhenBusy: boolean) =>
      withSharedStoreHandles(
        (session) => {
          const db = openIn(session);
          noteStoreBusy('test write skipped', session);
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
      const first = grantFor({ session: stores }).open(root);
      const second = grantFor({ session: stores }).open(other);
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
