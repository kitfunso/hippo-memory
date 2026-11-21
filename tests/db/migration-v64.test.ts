// Schema v64 adds the lead_in column and never raises the floor; the first row written with a lead-in does.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, getMeta, getSchemaVersion, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { v64 } from '../../src/db/migrations/v64.js';
import { tableColumns, tableHasColumn } from '../../src/db/tables.js';
import { LEAD_IN_MIN_BINARY } from '../../src/base/util/version.js';
import { MEMORY_ROW_COLUMNS } from '../../src/store/sqlite/runtime/rows.js';
import { updateMemoryRows, upsertMemoryRow } from '../../src/store/sqlite/entries/entry-row.js';
import { initStore } from '../../src/store/sqlite/runtime/handles.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';

const FLOOR_KEY = 'min_compatible_binary';

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Takes a current store back to v63: no lead_in, both versions stamped 63, so the next open runs v64. */
function toV63(db: DatabaseSyncLike): void {
  db.exec('ALTER TABLE memories DROP COLUMN lead_in');
  setMeta(db, 'schema_version', '63');
  db.exec('PRAGMA user_version = 63');
}

function storedLeadIn(db: DatabaseSyncLike, id: string): string | null {
  // SAFETY: the SELECT names one nullable TEXT column, lead_in.
  return (db.prepare('SELECT lead_in FROM memories WHERE id = ?').get(id) as { lead_in: string | null }).lead_in;
}

describe('migration v64', () => {
  it('adds lead_in, runs twice safely, and leaves min_compatible_binary alone', () => {
    const root = makeRoot('migration-v64-adds');
    const floor = withDb(root, (db) => {
      toV63(db);
      expect(tableHasColumn(db, 'memories', 'lead_in')).toBe(false);
      return getMeta(db, FLOOR_KEY);
    });

    initStore(root);

    withDb(root, (db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tableHasColumn(db, 'memories', 'lead_in')).toBe(true);
      expect(getMeta(db, FLOOR_KEY)).toBe(floor);
      const columns = tableColumns(db, 'memories');
      v64.up(db);
      v64.up(db);
      expect(tableColumns(db, 'memories')).toEqual(columns);
      expect(getMeta(db, FLOOR_KEY)).toBe(floor);
    });
  });
});

describe('the lead-in floor', () => {
  it('rises on the first lead-in row through upsertMemoryRow, and not on a row with none', () => {
    const root = makeRoot('migration-v64-upsert');
    withDb(root, (db) => {
      const floor = getMeta(db, FLOOR_KEY);
      upsertMemoryRow(db, createMemory('a row with no lead-in'));
      expect(getMeta(db, FLOOR_KEY)).toBe(floor);
      expect(floor).not.toBe(LEAD_IN_MIN_BINARY);

      const led = createMemory('Three times a week', { leadIn: 'user: How often do you run?' });
      upsertMemoryRow(db, led);

      expect(getMeta(db, FLOOR_KEY)).toBe(LEAD_IN_MIN_BINARY);
      expect(storedLeadIn(db, led.id)).toBe('user: How often do you run?');
    });
  });

  it('rises on the first lead-in row through updateMemoryRows, and not on a row with none', () => {
    const root = makeRoot('migration-v64-update');
    withDb(root, (db) => {
      const row = createMemory('a row that gains a lead-in later');
      upsertMemoryRow(db, row);
      const floor = getMeta(db, FLOOR_KEY);

      updateMemoryRows(db, [{ ...row, strength: 0.5 }]);
      expect(getMeta(db, FLOOR_KEY)).toBe(floor);

      updateMemoryRows(db, [{ ...row, leadIn: 'user: what changed?' }]);
      expect(getMeta(db, FLOOR_KEY)).toBe(LEAD_IN_MIN_BINARY);
      expect(storedLeadIn(db, row.id)).toBe('user: what changed?');
    });
  });

  it('never lowers a higher floor', () => {
    const root = makeRoot('migration-v64-higher');
    withDb(root, (db) => {
      setMeta(db, FLOOR_KEY, '9.0.0');
      const row = createMemory('a row with no lead-in yet');
      upsertMemoryRow(db, createMemory('Yes.', { leadIn: 'user: is it booked?' }));
      upsertMemoryRow(db, row);
      updateMemoryRows(db, [{ ...row, leadIn: 'user: and this one?' }]);
      expect(getMeta(db, FLOOR_KEY)).toBe('9.0.0');
    });
  });

  it('keeps the stored lead-in through an UPDATE that lists the v63 columns, as an older binary writes it', () => {
    const root = makeRoot('migration-v64-older');
    withDb(root, (db) => {
      const row = createMemory('the content an older binary rewrites', { leadIn: 'user: keep this' });
      upsertMemoryRow(db, row);
      const v63Columns = MEMORY_ROW_COLUMNS.filter((column) => column !== 'lead_in');
      // SAFETY: the SELECT names the v63 columns, so each key is a column name and each value a SQLite scalar.
      const stored = db.prepare(`SELECT ${v63Columns.join(', ')} FROM memories WHERE id = ?`).get(row.id) as Record<
        string,
        string | number | null
      >;
      const set = v63Columns.slice(1).map((column) => `${column} = ?`);
      const values = v63Columns.slice(1).map((column) => (column === 'content' ? 'rewritten' : (stored[column] ?? null)));

      db.prepare(`UPDATE memories SET ${set.join(', ')} WHERE id = ?`).run(...values, row.id);

      expect(storedLeadIn(db, row.id)).toBe('user: keep this');
      // SAFETY: the SELECT names one TEXT column, content.
      expect((db.prepare('SELECT content FROM memories WHERE id = ?').get(row.id) as { content: string }).content).toBe(
        'rewritten',
      );
    });
  });
});
