// Schema v60 adds the decay-key index that loadContextCandidates reads past the cap.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, getSchemaVersion, type DatabaseSyncLike } from '../src/db/index.js';
import { DECAY_KEY_INDEX, DECAY_KEY_SQL } from '../src/db/decay-key.js';
import { v60 } from '../src/db/migrations/v60.js';
import { writeEntryDbOnly } from '../src/store/entry-writes.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
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

function indexSql(db: DatabaseSyncLike): string | undefined {
  // SAFETY: one TEXT `sql` column.
  return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(DECAY_KEY_INDEX) as { sql?: string } | undefined)?.sql;
}

beforeEach(() => {
  home = makeRoot('migration-v60');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v60', () => {
  it('a fresh store has the decay-key index, led by tenant and pinned', () => {
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(indexSql(db)).toContain(`ON memories(tenant_id, pinned, (${DECAY_KEY_SQL}))`);
    });
  });

  it('a v56 store gains the index on open, keeps its rows, and a re-run changes nothing', () => {
    const entry = createMemory('survives the index build', { tenantId: 'default' });
    withDb((db) => writeEntryDbOnly(db, entry));
    withDb((db) => {
      db.exec(`DROP INDEX ${DECAY_KEY_INDEX}`);
      db.prepare(`UPDATE meta SET value = '56' WHERE key = 'schema_version'`).run();
      db.exec('PRAGMA user_version = 56');
    });
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const sql = indexSql(db);
      expect(sql).toBeDefined();
      expect(db.prepare('SELECT id FROM memories').all()).toEqual([{ id: entry.id }]);
      v60.up(db, {});
      expect(indexSql(db)).toBe(sql);
    });
  });
});
