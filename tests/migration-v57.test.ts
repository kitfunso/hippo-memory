// Schema v57 adds token_ledger.sent_keys, the per-memory send marks of the hook's context window.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, openHippoDbReadOnly, closeHippoDb, getSchemaVersion, type DatabaseSyncLike } from '../src/db/index.js';
import { v57 } from '../src/db/migrations/v57.js';
import { tableColumns, tableExists } from '../src/db/tables.js';
import { recordTokenUse, sentInWindow } from '../src/store/token-ledger.js';
import { makeRoot } from './_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from './_helpers/schema-version.js';

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Puts the store back to its v56 shape, keeping every row; `alsoRun` changes it further before the close. */
function rewindToV56(alsoRun?: (db: DatabaseSyncLike) => void): void {
  withDb((db) => {
    if (tableExists(db, 'token_ledger')) db.exec('ALTER TABLE token_ledger DROP COLUMN sent_keys');
    db.prepare(`UPDATE meta SET value = '56' WHERE key = 'schema_version'`).run();
    db.exec('PRAGMA user_version = 56');
    alsoRun?.(db);
  });
}

beforeEach(() => {
  home = makeRoot('migration-v57');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v57', () => {
  it('a fresh store has the sent_keys column', () => {
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tableColumns(db, 'token_ledger').has('sent_keys')).toBe(true);
    });
  });

  it('a v56 store gains the column, its rows stay NULL and never mark a send, and a re-run changes nothing', () => {
    rewindToV56((db) => {
      db.prepare(
        `INSERT INTO token_ledger (ts, tenant_id, session_id, surface, event, items, tokens, block_hash)
         VALUES (?, 'default', 's1', 'hook', 'inject', 2, 100, 'abcdef0123456789')`,
      ).run(new Date().toISOString());
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // SAFETY: the SELECT names exactly these two columns.
      const rows = db.prepare('SELECT event, sent_keys FROM token_ledger').all();
      expect(rows).toEqual([{ event: 'inject', sent_keys: null }]);
      expect(sentInWindow(db, 'default', 's1', 'hook')).toEqual({ turn: 0, sent: new Map() });
      recordTokenUse(db, { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'inject', items: 1, tokens: 9, sentKeys: ['mem:a:1'] });
      expect(sentInWindow(db, 'default', 's1', 'hook')).toEqual({ turn: 1, sent: new Map([['mem:a:1', { turn: 1 }]]) });
      const before = [...tableColumns(db, 'token_ledger')];
      v57.up(db, {});
      expect([...tableColumns(db, 'token_ledger')]).toEqual(before);
    });
  });

  it('a store without token_ledger upgrades without throwing', () => {
    rewindToV56((db) => db.exec('DROP TABLE token_ledger'));
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tableExists(db, 'token_ledger')).toBe(false);
    });
  });

  it('a failure inside v57 rolls it back whole: schema 56 and no column', () => {
    rewindToV56();
    const up = v57.up;
    const spy = vi.spyOn(v57, 'up').mockImplementation((db, opts) => {
      up(db, opts);
      throw new Error('v57 boom');
    });
    try {
      expect(() => withDb(() => undefined)).toThrow('v57 boom');
    } finally {
      spy.mockRestore();
    }
    const db = openHippoDbReadOnly(home);
    try {
      expect(getSchemaVersion(db)).toBe(56);
      expect(tableColumns(db, 'token_ledger').has('sent_keys')).toBe(false);
    } finally {
      closeHippoDb(db);
    }
    withDb((d) => expect(getSchemaVersion(d)).toBe(LATEST_SCHEMA_VERSION));
  });
});
