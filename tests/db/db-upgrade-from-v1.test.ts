import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { openHippoDb, closeHippoDb, getHippoDbPath, getSchemaVersion } from '../../src/db/index.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { dumpSchema } from '../_helpers/schema-dump.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, readEntry } from '../_helpers/root-forms.js';

// Frozen copy of migration v1's DDL: the oldest store shape a user can still have on disk.
const V1_DDL = `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY, created TEXT NOT NULL, last_retrieved TEXT NOT NULL,
    retrieval_count INTEGER NOT NULL, strength REAL NOT NULL, half_life_days REAL NOT NULL,
    layer TEXT NOT NULL, tags_json TEXT NOT NULL, emotional_valence TEXT NOT NULL,
    schema_fit REAL NOT NULL, source TEXT NOT NULL, outcome_score REAL,
    conflicts_with_json TEXT NOT NULL, pinned INTEGER NOT NULL, confidence TEXT NOT NULL,
    content TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE consolidation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
    decayed INTEGER NOT NULL, merged INTEGER NOT NULL, removed INTEGER NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta (key, value) VALUES ('schema_version', '1');
  PRAGMA user_version = 1;
`;

describe('upgrading a populated v1 store to the latest schema', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('upgrade-v1', { init: false });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const old = new DatabaseSync(getHippoDbPath(root));
    old.exec(V1_DDL);
    const insert = old.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json,
        emotional_valence, schema_fit, source, outcome_score, conflicts_with_json, pinned, confidence, content)
       VALUES (?, '2025-01-02T03:04:05.000Z', '2025-02-03T04:05:06.000Z', ?, ?, 30, ?, ?, 'neutral', 0.5, 'cli', NULL, '[]', ?, 'verified', ?)`,
    );
    insert.run(
      'mem_old_1',
      3,
      0.8,
      'semantic',
      '["alpha","beta"]',
      1,
      'a pinned semantic lesson from the first release',
    );
    insert.run('mem_old_2', 0, 0.4, 'episodic', '[]', 0, 'an episodic note');
    old
      .prepare(
        `INSERT INTO consolidation_runs (timestamp, decayed, merged, removed) VALUES ('2025-02-01T00:00:00.000Z', 4, 2, 1)`,
      )
      .run();
    old.close();
  });

  it('migrates to the latest version with every row and field intact', () => {
    const db = openHippoDb(root);
    try {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // SAFETY: row shapes follow the selected columns.
      const meta = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
      expect(meta.value).toBe(String(LATEST_SCHEMA_VERSION));
      const runs = db.prepare(`SELECT decayed, merged, removed FROM consolidation_runs`).all();
      expect(runs).toEqual([{ decayed: 4, merged: 2, removed: 1 }]);
    } finally {
      closeHippoDb(db);
    }

    const entries = loadAllEntries(root, 'default');
    expect(entries.map((e) => e.id).sort()).toEqual(['mem_old_1', 'mem_old_2']);
    const lesson = readEntry(root, 'mem_old_1')!;
    expect(lesson.content).toBe('a pinned semantic lesson from the first release');
    expect(lesson.tags).toEqual(['alpha', 'beta']);
    expect(lesson.pinned).toBe(true);
    expect(lesson.retrievalCount).toBe(3);
    expect(lesson.strength).toBeCloseTo(0.8);
    expect(lesson.created).toBe('2025-01-02T03:04:05.000Z');
  });

  // A fresh store's schema is pinned in db-schema-snapshot, so the upgrade path pins only where it differs.
  it('ends with the fresh-store schema after the full migration chain, less two memories indexes', () => {
    const freshDb = openHippoDb(makeRoot('upgrade-v1-fresh'));
    const db = openHippoDb(root);
    try {
      const [fresh, upgraded] = [dumpSchema(freshDb), dumpSchema(db)];
      expect(upgraded.userVersion).toBe(fresh.userVersion);
      expect({
        onlyFresh: fresh.objects.filter((o) => !upgraded.objects.includes(o)),
        onlyUpgraded: upgraded.objects.filter((o) => !fresh.objects.includes(o)),
      }).toEqual({
        onlyFresh: [
          'index idx_memories_last_retrieved: CREATE INDEX idx_memories_last_retrieved ON memories(last_retrieved)',
          'index idx_memories_layer_created: CREATE INDEX idx_memories_layer_created ON memories(layer, created)',
        ],
        onlyUpgraded: [],
      });
    } finally {
      closeHippoDb(db);
      closeHippoDb(freshDb);
    }
  });

  it('reopening the migrated store is a no-op for the data', () => {
    closeHippoDb(openHippoDb(root));
    const db = openHippoDb(root);
    try {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      closeHippoDb(db);
    }
    expect(loadAllEntries(root, 'default')).toHaveLength(2);
  });
});
