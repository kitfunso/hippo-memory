// A hold on a signed delivery lives in hippo.db, so it survives a restart and a second handle, and expired holds do not pile up.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const TTL = 1000;
let root: string;

beforeEach(() => {
  root = makeRoot('delivery-hold');
});

afterEach(() => {
  removeAfterRequest(root);
});

const claimOn = (store: ReturnType<typeof sqliteSyncStore>, key: string, nowMs: number) =>
  store.connectorEvents.claimDelivery({ connector: 'slack', key, nowMs, ttlMs: TTL });
/** Each call builds a store of its own, as a restarted server would. */
const claim = (key: string, nowMs: number) => claimOn(sqliteSyncStore(root), key, nowMs);

function holdRows(): number {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'delivery_hold:%'`).get() as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

describe('claimDelivery', () => {
  it('refuses a key held by an earlier store handle, as a restarted server would', async () => {
    expect(await claim('sig-a', 0)).toBe(true);
    expect(await claim('sig-a', 500)).toBe(false);
    expect(await claim('sig-b', 500)).toBe(true);
  });

  it('frees a released key, and keeps a failed delivery from holding its retry back', async () => {
    await claim('sig-a', 0);
    await sqliteSyncStore(root).connectorEvents.releaseDelivery('slack', 'sig-a');
    expect(await claim('sig-a', 1)).toBe(true);
  });

  it('sweeps the holds that ran out, so the rows stay as many as the holds still live', async () => {
    const store = sqliteSyncStore(root);
    for (let i = 0; i < 40; i++) await claimOn(store, `sig-${i}`, 0);
    expect(holdRows()).toBe(40);

    expect(await claimOn(store, 'late', TTL)).toBe(true);
    expect(holdRows()).toBe(1);
  });
});
