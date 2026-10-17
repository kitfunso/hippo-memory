// Schema v55 adds the tool-call key and failure link to delivery_events, plus the partial unique index over the key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, openHippoDbReadOnly, closeHippoDb, getSchemaVersion, type DatabaseSyncLike } from '../../src/db/index.js';
import { v55 } from '../../src/db/migrations/v55.js';
import { tableColumns, tableExists } from '../../src/db/tables.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';

const INDEX = 'idx_delivery_events_tool_call';

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function indexSql(db: DatabaseSyncLike, name: string): string | undefined {
  // SAFETY: one TEXT `sql` column.
  return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) as { sql?: string } | undefined)?.sql;
}

function addEvent(db: DatabaseSyncLike, session: string): void {
  db.prepare(
    `INSERT INTO delivery_events (ts, ledger_version, runtime, event_type, surface, store_hash, write_store, session_id, session_state, block_state)
     VALUES (?, 3, 'claude-code', 'prompt-submit', 'hook', 'abcdef0123456789', 'local', ?, 'payload', 'sent')`,
  ).run(new Date().toISOString(), session);
}

/** Puts the store back to its v54 shape, keeping every row; `alsoRun` changes it further before the close. */
function rewindToV54(alsoRun?: (db: DatabaseSyncLike) => void): void {
  withDb((db) => {
    db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
    if (tableExists(db, 'delivery_events')) {
      db.exec('ALTER TABLE delivery_events DROP COLUMN tool_use_id');
      db.exec('ALTER TABLE delivery_events DROP COLUMN failure_id');
    }
    db.prepare(`UPDATE meta SET value = '54' WHERE key = 'schema_version'`).run();
    db.exec('PRAGMA user_version = 54');
    alsoRun?.(db);
  });
}

beforeEach(() => {
  home = makeRoot('migration-v55');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v55', () => {
  it('a fresh store has both columns and the partial unique index', () => {
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect([...tableColumns(db, 'delivery_events')]).toEqual(expect.arrayContaining(['tool_use_id', 'failure_id']));
      expect(indexSql(db, INDEX)).toMatch(/UNIQUE INDEX .*\(tenant_id, session_id, tool_use_id\)\s+WHERE tool_use_id IS NOT NULL AND turn_seq IS NOT NULL/s);
    });
  });

  it('a v54 store gains both columns and the index, its rows stay, and a re-run changes nothing', () => {
    withDb((db) => addEvent(db, 's1'));
    rewindToV54();
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect([...tableColumns(db, 'delivery_events')]).toEqual(expect.arrayContaining(['tool_use_id', 'failure_id']));
      expect(indexSql(db, INDEX)).toBeDefined();
      // SAFETY: the SELECT names exactly these three columns.
      const rows = db.prepare('SELECT session_id, tool_use_id, failure_id FROM delivery_events').all();
      expect(rows).toEqual([{ session_id: 's1', tool_use_id: null, failure_id: null }]);
      const before = [...tableColumns(db, 'delivery_events')];
      const sql = indexSql(db, INDEX);
      v55.up(db, {});
      expect([...tableColumns(db, 'delivery_events')]).toEqual(before);
      expect(indexSql(db, INDEX)).toBe(sql);
    });
  });

  it('a store without delivery_events upgrades without throwing and gets neither table nor index', () => {
    rewindToV54((db) => {
      db.exec('DROP TABLE delivery_candidates');
      db.exec('DROP TABLE delivery_events');
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tableExists(db, 'delivery_events')).toBe(false);
      expect(indexSql(db, INDEX)).toBeUndefined();
    });
  });

  it('a failure inside v55 rolls it back whole: schema 54 and none of its columns or its index', () => {
    rewindToV54();
    const up = v55.up;
    const spy = vi.spyOn(v55, 'up').mockImplementation((db, opts) => {
      up(db, opts);
      throw new Error('v55 boom');
    });
    try {
      expect(() => withDb(() => undefined)).toThrow('v55 boom');
    } finally {
      spy.mockRestore();
    }
    const db = openHippoDbReadOnly(home);
    try {
      expect(getSchemaVersion(db)).toBe(54);
      expect(tableColumns(db, 'delivery_events').has('tool_use_id')).toBe(false);
      expect(tableColumns(db, 'delivery_events').has('failure_id')).toBe(false);
      expect(indexSql(db, INDEX)).toBeUndefined();
    } finally {
      closeHippoDb(db);
    }
    withDb((d) => expect(getSchemaVersion(d)).toBe(LATEST_SCHEMA_VERSION));
  });
});
