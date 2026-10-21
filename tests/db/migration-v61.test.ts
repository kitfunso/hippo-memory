// Schema v61 adds the predictions page index and the memories project index; the real reads must plan onto them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, getSchemaVersion, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { selectEntriesFromOrigin } from '../../src/store/sqlite/entry-reads.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { loadAllPredictions, writeEntry } from '../_helpers/root-forms.js';

const PRED_INDEX = 'idx_predictions_tenant_created';
const MEM_INDEX = 'idx_memories_tenant_origin_created';
const TEMP_SORT = 'USE TEMP B-TREE FOR ORDER BY';

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function plan(db: DatabaseSyncLike, sql: string): string {
  const binds = Array.from({ length: sql.split('?').length - 1 }, () => 'x');
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join(' | ');
}

function count(db: DatabaseSyncLike, table: string): number {
  // SAFETY: one COUNT column.
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function failNoSql(): never {
  throw new Error('the read did not prepare the expected statement');
}

function insertPredictions(db: DatabaseSyncLike, count: number): void {
  const add = db.prepare(
    `INSERT INTO predictions (tenant_id, class_tag, claim_text, created_at) VALUES ('default', 'c', ?, ?)`,
  );
  for (let i = 0; i < count; i++) add.run(`claim ${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
}

beforeEach(() => {
  home = makeRoot('migration-v61');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v61', () => {
  it('pages predictions off the tenant index with no sort', () => {
    withDb((db) => insertPredictions(db, 12));
    const first = loadAllPredictions(home, 'default', { limit: 5 });
    const last = first[first.length - 1];
    const { statements } = recordStatements(() =>
      loadAllPredictions(home, 'default', {
        limit: 5,
        after: { key: last.createdAt, id: last.id },
      }),
    );
    const sql = statements.find((s) => s.includes('FROM predictions') && s.includes('ORDER BY created_at DESC'));
    withDb((db) => {
      const detail = plan(db, sql ?? failNoSql());
      expect(detail).toContain(`USING INDEX ${PRED_INDEX}`);
      expect(detail).not.toContain(TEMP_SORT);
    });
  });

  it('pages one project off the tenant and project index with no sort', () => {
    for (let i = 0; i < 6; i++) {
      writeEntry(home, {
        ...createMemory(`row ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
        originProject: 'alpha',
      });
    }
    const { statements } = recordStatements(() =>
      withDb((db) =>
        selectEntriesFromOrigin(db, 'default', { origin: 'alpha', live: true }, { limit: 2, after: undefined }),
      ),
    );
    const sql = statements.find((s) => s.includes('origin_project = ?') && s.includes('ORDER BY created ASC'));
    withDb((db) => {
      const detail = plan(db, sql ?? failNoSql());
      expect(detail).toContain(`USING INDEX ${MEM_INDEX}`);
      expect(detail).not.toContain(TEMP_SORT);
    });
  });

  it('upgrades a v60 store with rows in it and keeps every row', () => {
    withDb((db) => insertPredictions(db, 4));
    writeEntry(home, { ...createMemory('kept', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), originProject: 'alpha' });
    withDb((db) => {
      db.exec(`DROP INDEX ${PRED_INDEX}`);
      db.exec(`DROP INDEX ${MEM_INDEX}`);
      db.prepare(`UPDATE meta SET value = '60' WHERE key = 'schema_version'`).run();
      db.exec('PRAGMA user_version = 60');
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // SAFETY: one `name` TEXT column.
      const names = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining([PRED_INDEX, MEM_INDEX]));
      expect(count(db, 'predictions')).toBe(4);
      expect(count(db, 'memories')).toBe(1);
    });
  });
});
