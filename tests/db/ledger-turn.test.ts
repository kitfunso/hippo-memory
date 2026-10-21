// One turn's token rows and delivery event through hippo.db's Ledger (src/store/sqlite/ledger.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createDeliveryRecorder, type DeliveryRecorder } from '../../src/api/delivery-recorder.js';
import { readDeliveryEvents } from '../_helpers/delivery-events.js';
import type { TokenUse } from '../../src/store/port/ledger.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore, sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { log } from '../../src/base/util/log.js';

const HASH = 'aaaaaaaaaaaaaaaa';
// Run once per connection open; the delivery writer resets busy_timeout, so that pragma would overcount.
const STORE_OPEN = 'PRAGMA journal_mode = WAL';

let root: string;

beforeEach(() => {
  root = makeRoot('ledger-turn');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function use(over: Partial<TokenUse> = {}): TokenUse {
  return {
    tenantId: 'default',
    sessionId: 's1',
    surface: 'hook',
    event: 'inject',
    items: 1,
    tokens: 40,
    hash: HASH,
    ...over,
  };
}

function onDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function ledgerSurfaces(): string[] {
  // SAFETY: the SELECT names exactly this one TEXT column.
  return onDb(
    (db) => db.prepare('SELECT surface FROM token_ledger ORDER BY id').all() as Array<{ surface: string }>,
  ).map((r) => r.surface);
}

function deliveryCount(): number {
  return onDb((db) => readDeliveryEvents(db, 'default', 's1').length);
}

function recorder(): DeliveryRecorder {
  return createDeliveryRecorder({
    ledger: sqliteStore(root).ledger,
    storeHash: HASH,
    writeStore: 'local',
    tenantId: 'default',
    stdinText: JSON.stringify({ session_id: 's1', prompt: 'the raw prompt text', hook_event_name: 'UserPromptSubmit' }),
  });
}

/** Makes every insert on `surface` fail, so one row of a turn can fail while the others land. */
function failRowsOn(surface: string): void {
  onDb((db) =>
    db.exec(
      `CREATE TRIGGER ledger_turn_boom BEFORE INSERT ON token_ledger WHEN NEW.surface = '${surface}' BEGIN SELECT RAISE(ABORT, 'row boom'); END`,
    ),
  );
}

describe('Ledger.recordTurn', () => {
  it('books the rows in order and then the delivery event, on one store open', () => {
    const rec = recorder();
    const delivery = rec.takeEvent() ?? undefined;
    const run = recordStatements(() =>
      sqliteSyncStore(handlesOf(root)).ledger.recordTurn({ uses: [use(), use({ surface: 'hook_recall' })], delivery }),
    );
    expect(countMatching(run.statements, STORE_OPEN)).toBe(1);
    const lastTokenRow = run.statements.map((sql) => sql.includes('INSERT INTO token_ledger')).lastIndexOf(true);
    expect(run.statements.findIndex((sql) => sql.includes('INSERT INTO delivery_events'))).toBeGreaterThan(
      lastTokenRow,
    );
    expect(ledgerSurfaces()).toEqual(['hook', 'hook_recall']);
    expect(deliveryCount()).toBe(1);
  });

  it('without perRow the first failed row stops the rest, and the delivery event still lands', () => {
    failRowsOn('hook');
    const rec = recorder();
    sqliteSyncStore(handlesOf(root)).ledger.recordTurn({
      uses: [use(), use({ surface: 'hook_recall' })],
      delivery: rec.takeEvent() ?? undefined,
    });
    expect(ledgerSurfaces()).toEqual([]);
    expect(deliveryCount()).toBe(1);
  });

  it('with perRow a failed row is noted, the other rows land and the delivery event is stored', () => {
    failRowsOn('hook');
    const rec = recorder();
    const noted = vi.spyOn(log, 'warnThenDebug');
    sqliteSyncStore(handlesOf(root)).ledger.recordTurn({
      uses: [use(), use({ surface: 'hook_recall' })],
      perRow: true,
      delivery: rec.takeEvent() ?? undefined,
    });
    expect(noted.mock.calls.filter(([key]) => key === 'token-ledger-row')).toHaveLength(1);
    expect(String(noted.mock.calls[0]?.[1])).toContain('row boom');
    noted.mockRestore();
    expect(ledgerSurfaces()).toEqual(['hook_recall']);
    expect(deliveryCount()).toBe(1);
  });
});

describe('Ledger.lastSent', () => {
  it('reads the last injected hash and the skips since it, and null for a session with no rows', () => {
    sqliteSyncStore(handlesOf(root)).ledger.recordTurn({ uses: [use(), use({ event: 'skip' })] });
    expect(sqliteSyncStore(handlesOf(root)).ledger.lastSent('default', 's1', 'hook')).toEqual({
      hash: HASH,
      skipsSince: 1,
    });
    expect(sqliteSyncStore(handlesOf(root)).ledger.lastSent('default', 's1', 'context')).toBeNull();
    expect(sqliteSyncStore(handlesOf(root)).ledger.lastSent('default', 'other', 'hook')).toBeNull();
    expect(sqliteSyncStore(handlesOf(root)).ledger.lastSent('default', undefined, 'hook')).toBeNull();
  });
});
