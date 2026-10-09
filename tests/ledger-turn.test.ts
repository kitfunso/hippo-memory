// One turn's token rows and delivery event by store root (src/store/ledger-turn.ts), on a real SQLite store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createDeliveryRecorder, type DeliveryRecorder } from '../src/delivery-recorder.js';
import { lastSentOnSurface, recordLedgerTurn } from '../src/store/ledger-turn.js';
import { readDeliveryEvents } from '../src/store/recall-trace.js';
import type { TokenUse } from '../src/token-ledger.js';
import { countMatching, recordStatements } from './_helpers/count-statements.js';
import { makeRoot } from './_helpers/make-root.js';

const HASH = 'aaaaaaaaaaaaaaaa';
// Run once per connection open; the delivery writer resets busy_timeout, so that pragma would overcount.
const STORE_OPEN = 'PRAGMA journal_mode = WAL';

let root: string;

beforeEach(() => { root = makeRoot('ledger-turn'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function use(over: Partial<TokenUse> = {}): TokenUse {
  return { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'inject', items: 1, tokens: 40, hash: HASH, ...over };
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
  return onDb((db) => db.prepare('SELECT surface FROM token_ledger ORDER BY id').all() as Array<{ surface: string }>).map((r) => r.surface);
}

function deliveryCount(): number {
  return onDb((db) => readDeliveryEvents(db, 'default', 's1').length);
}

function recorder(): DeliveryRecorder {
  return createDeliveryRecorder({
    root, storeHash: HASH, writeStore: 'local', tenantId: 'default',
    stdinText: JSON.stringify({ session_id: 's1', prompt: 'the raw prompt text', hook_event_name: 'UserPromptSubmit' }),
  });
}

/** Makes every insert on `surface` fail, so one row of a turn can fail while the others land. */
function failRowsOn(surface: string): void {
  onDb((db) => db.exec(
    `CREATE TRIGGER ledger_turn_boom BEFORE INSERT ON token_ledger WHEN NEW.surface = '${surface}' BEGIN SELECT RAISE(ABORT, 'row boom'); END`,
  ));
}

describe('recordLedgerTurn', () => {
  it('books the rows in order and then the delivery event, on one store open', () => {
    const rec = recorder();
    const log = recordStatements(() => recordLedgerTurn(root, {
      uses: [use(), use({ surface: 'hook_recall' })],
      delivery: (write) => rec.flush(write),
    }));
    expect(countMatching(log.statements, STORE_OPEN)).toBe(1);
    const lastTokenRow = log.statements.map((sql) => sql.includes('INSERT INTO token_ledger')).lastIndexOf(true);
    expect(log.statements.findIndex((sql) => sql.includes('INSERT INTO delivery_events'))).toBeGreaterThan(lastTokenRow);
    expect(ledgerSurfaces()).toEqual(['hook', 'hook_recall']);
    expect(deliveryCount()).toBe(1);
  });

  it('without onRowError the first failed row throws: no later row and no delivery event', () => {
    failRowsOn('hook');
    const rec = recorder();
    expect(() => recordLedgerTurn(root, {
      uses: [use(), use({ surface: 'hook_recall' })],
      delivery: (write) => rec.flush(write),
    })).toThrow('row boom');
    expect(ledgerSurfaces()).toEqual([]);
    expect(deliveryCount()).toBe(0);
  });

  it('with onRowError a failed row is reported, the other rows land and the delivery event is stored', () => {
    failRowsOn('hook');
    const rec = recorder();
    const failed: string[] = [];
    recordLedgerTurn(root, {
      uses: [use(), use({ surface: 'hook_recall' })],
      onRowError: (error) => { failed.push(String(error)); },
      delivery: (write) => rec.flush(write),
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('row boom');
    expect(ledgerSurfaces()).toEqual(['hook_recall']);
    expect(deliveryCount()).toBe(1);
  });
});

describe('lastSentOnSurface', () => {
  it('reads the last injected hash and the skips since it, and null for a session with no rows', () => {
    recordLedgerTurn(root, { uses: [use(), use({ event: 'skip' })] });
    expect(lastSentOnSurface(root, 'default', 's1', 'hook')).toEqual({ hash: HASH, skipsSince: 1 });
    expect(lastSentOnSurface(root, 'default', 's1', 'context')).toBeNull();
    expect(lastSentOnSurface(root, 'default', 'other', 'hook')).toBeNull();
    expect(lastSentOnSurface(root, 'default', undefined, 'hook')).toBeNull();
  });
});
