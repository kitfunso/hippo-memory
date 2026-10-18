// Schema v60 adds the decay-key index that loadContextCandidates reads past the cap.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  openHippoDb,
  closeHippoDb,
  getHippoDbPath,
  getSchemaVersion,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { DECAY_KEY_INDEX, DECAY_KEY_SQL, DECAY_KEY_WHERE } from '../../src/db/decay-key.js';
import { v60 } from '../../src/db/migrations/v60.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';

// The schema of a store at version 56, frozen as SQL: the last version before migration 60.
const V56_SCHEMA = join(__dirname, '..', 'fixtures', 'schema-v56.sql');

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
  return (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(DECAY_KEY_INDEX) as
      | { sql?: string }
      | undefined
  )?.sql;
}

beforeEach(() => {
  home = makeRoot('migration-v60');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v60', () => {
  it('a fresh store has the decay-key index, led by tenant and pinned, over rows with a half-life', () => {
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(indexSql(db)).toContain(`ON memories(tenant_id, pinned, (${DECAY_KEY_SQL})) WHERE ${DECAY_KEY_WHERE}`);
    });
  });

  it('a v56 store gains the index on open, keeps its rows, and a re-run changes nothing', () => {
    home = makeRoot('migration-v60-old', { init: false });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const old = new DatabaseSync(getHippoDbPath(home));
    old.exec(readFileSync(V56_SCHEMA, 'utf8'));
    old
      .prepare(
        `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json,
        emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content)
       VALUES ('mem_v56_row', '2025-01-02T03:04:05.000Z', '2025-02-03T04:05:06.000Z', 0, 1, 30, 'semantic', '[]', 'neutral', 0.5, 'cli', '[]', 0, 'verified', 'survives the index build')`,
      )
      .run();
    expect(old.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(DECAY_KEY_INDEX)).toBeUndefined();
    old.close();
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const sql = indexSql(db);
      expect(sql).toBeDefined();
      expect(db.prepare('SELECT id FROM memories').all()).toEqual([{ id: 'mem_v56_row' }]);
      v60.up(db, {});
      expect(indexSql(db)).toBe(sql);
    });
  });
});
