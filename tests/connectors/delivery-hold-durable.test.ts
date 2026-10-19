// A hold on a signed delivery lives in hippo.db, so it survives a restart and a second handle, and expired holds do not pile up.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

const TTL = 1000;
let root: string;

beforeEach(() => {
  root = makeRoot('delivery-hold');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const claim = (key: string, nowMs: number, connector: 'slack' | 'github' = 'slack') =>
  sqliteSyncStore(root).connectorEvents.claimDelivery({ connector, key, nowMs, ttlMs: TTL });

function holdRows(): number {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'delivery_hold:%'`).get<{ n: number }>();
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
    for (let i = 0; i < 40; i++) await claim(`sig-${i}`, 0);
    expect(holdRows()).toBe(40);

    expect(await claim('late', TTL)).toBe(true);
    expect(holdRows()).toBe(1);
  });
});
