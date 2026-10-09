// The ambient pinned query and its date-drift probe must run off the v51 partial indexes, not a memories scan.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAmbientCandidates } from '../src/store/candidates.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { recordStatements } from './_helpers/count-statements.js';
import { LATEST_SCHEMA_VERSION_STR } from './_helpers/schema-version.js';

/** The pinned and drift statements loadAmbientCandidates really prepares, so the plan checks run the production SQL. */
interface AmbientSql {
  readonly pinned: string;
  readonly drift: string;
}

function ambientSql(root: string): AmbientSql {
  const { statements } = recordStatements(() => loadAmbientCandidates(root, 'default', 1, () => true));
  const pinned = statements.find((sql) => sql.includes('pinned = 1'));
  const drift = statements.find((sql) => sql.includes('length(created)'));
  if (pinned === undefined || drift === undefined) throw new Error('loadAmbientCandidates did not prepare the pinned and drift statements');
  return { pinned, drift };
}

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
    const { pinned: PINNED_SQL, drift: AMBIENT_DRIFT_SQL } = ambientSql(root);
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

  it('still reports drift and returns pins in created order through the indexes', () => {
    const { root, home } = seedStore();
    try {
      const { drift: AMBIENT_DRIFT_SQL } = ambientSql(root);
      const db = openHippoDb(root);
      try {
        // SAFETY: one `id` TEXT column.
        const seeded = (db.prepare(`SELECT id FROM memories WHERE pinned = 1 ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
        const created = ['2021-03-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', '2021-02-01T00:00:00.000Z'];
        seeded.forEach((id, i) => db.prepare(`UPDATE memories SET created = ? WHERE id = ?`).run(created[i], id));
        const pins = loadAmbientCandidates(root, 'default', 0, () => true).entries;
        expect(pins.map((e) => e.id)).toEqual([seeded[1], seeded[2], seeded[0]]);
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
