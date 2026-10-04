// The ambient pinned query and its date-drift probe must run off the v51 partial indexes, not a memories scan.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { initStore, writeEntry, loadAmbientCandidates, AMBIENT_PINNED_WHERE, AMBIENT_DRIFT_SQL, MEMORY_SELECT_COLUMNS } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { LATEST_SCHEMA_VERSION_STR } from './_helpers/schema-version.js';

const PINNED_SQL = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${AMBIENT_PINNED_WHERE}`;

function plan(db: DatabaseSyncLike, sql: string): string {
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('default') as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

function indexNames(db: DatabaseSyncLike): string[] {
  // SAFETY: one `name` TEXT column.
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'`).all() as Array<{ name: string }>).map((r) => r.name);
}

function seedStore() {
  const home = mkdtempSync(join(tmpdir(), 'hippo-pinned-plan-'));
  const root = join(home, '.hippo');
  initStore(root);
  for (let i = 0; i < 30; i++) {
    writeEntry(root, { ...createMemory(`row ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), pinned: i % 10 === 0 });
  }
  return { root, home };
}

describe('ambient pinned query plan', () => {
  it('uses idx_memories_pinned and idx_memories_created_drift', () => {
    const { root, home } = seedStore();
    const db = openHippoDb(root);
    try {
      expect(plan(db, PINNED_SQL)).toContain('USING INDEX idx_memories_pinned');
      expect(plan(db, PINNED_SQL)).not.toContain('SCAN memories');
      expect(plan(db, AMBIENT_DRIFT_SQL)).toContain('USING INDEX idx_memories_created_drift');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('scans memories without the indexes (the pre-v51 plan)', () => {
    const { root, home } = seedStore();
    const db = openHippoDb(root);
    try {
      db.exec('DROP INDEX idx_memories_pinned; DROP INDEX idx_memories_created_drift;');
      expect(plan(db, PINNED_SQL)).not.toContain('idx_memories_pinned');
      expect(plan(db, AMBIENT_DRIFT_SQL)).not.toContain('idx_memories_created_drift');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still reports drift and returns pins in created order through the indexes', () => {
    const { root, home } = seedStore();
    try {
      const pins = loadAmbientCandidates(root, 'default', 0, () => true).entries;
      expect(pins.map((e) => e.pinned)).toEqual([true, true, true]);
      const db = openHippoDb(root);
      try {
        expect(db.prepare(AMBIENT_DRIFT_SQL).get('default')).toBeUndefined();
        db.prepare(`UPDATE memories SET created = '2020-01-01' WHERE id = ?`).run(pins[0].id);
        expect(db.prepare(AMBIENT_DRIFT_SQL).get('default')).toBeDefined();
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a v50 store gains both indexes on open and a second open is a no-op', () => {
    const { root, home } = seedStore();
    let db = openHippoDb(root);
    try {
      db.exec('DROP INDEX idx_memories_pinned; DROP INDEX idx_memories_created_drift;');
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '50')`).run();
    } finally {
      closeHippoDb(db);
    }
    db = openHippoDb(root);
    let first: string[];
    try {
      first = indexNames(db);
      expect(first).toContain('idx_memories_pinned');
      expect(first).toContain('idx_memories_created_drift');
      // SAFETY: meta.value is TEXT; one row by primary key.
      expect((db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string }).value).toBe(LATEST_SCHEMA_VERSION_STR);
    } finally {
      closeHippoDb(db);
    }
    db = openHippoDb(root);
    try {
      expect(indexNames(db)).toEqual(first);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
