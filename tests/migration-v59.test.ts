// Schema v59 adds the vector graph's node, meta and queue tables, and the two triggers that keep the queue in step.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, openHippoDbReadOnly, closeHippoDb, getSchemaVersion, type DatabaseSyncLike } from '../src/db/index.js';
import { v59 } from '../src/db/migrations/v59.js';
import { tableExists } from '../src/db/tables.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveStoredVectors } from '../src/store/vector-index.js';
import { makeRoot } from './_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from './_helpers/schema-version.js';

const TABLES = ['memory_vector_nodes', 'memory_vector_index_meta', 'memory_vector_pending'];
const TRIGGERS = ['trg_memory_vector_nodes_delete', 'trg_memory_vectors_pending'];

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function triggers(db: DatabaseSyncLike): string[] {
  // SAFETY: the SELECT names exactly the one column read.
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?) ORDER BY name`)
    .all(...TRIGGERS) as { name: string }[];
  return rows.map((r) => r.name);
}

function pending(db: DatabaseSyncLike): string[] {
  // SAFETY: the SELECT names exactly the one column read.
  return (db.prepare('SELECT memory_id FROM memory_vector_pending ORDER BY memory_id').all() as { memory_id: string }[])
    .map((r) => r.memory_id);
}

/** Puts the store back to its v58 shape, keeping every row. */
function rewindToV58(): void {
  withDb((db) => {
    for (const t of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.prepare(`UPDATE meta SET value = '58' WHERE key = 'schema_version'`).run();
    db.exec('PRAGMA user_version = 58');
  });
}

function seedMemory(text: string): string {
  const entry = createMemory(text, { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(home, entry);
  return entry.id;
}

beforeEach(() => {
  home = makeRoot('migration-v59');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema v59', () => {
  it('a fresh store has the three tables and both triggers', () => {
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      for (const t of TABLES) expect(tableExists(db, t), t).toBe(true);
      expect(triggers(db)).toEqual(TRIGGERS);
    });
  });

  it('a v58 store gains them with its vectors untouched and unqueued, and a re-run changes nothing', () => {
    const id = seedMemory('kept from v58');
    saveStoredVectors(home, [[id, [1, 0]]], 'm');
    rewindToV58();
    withDb((db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(triggers(db)).toEqual(TRIGGERS);
      expect(pending(db)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()).toEqual({ n: 1 });
      v59.up(db, {});
      expect(triggers(db)).toEqual(TRIGGERS);
    });
  });

  it('an inserted vector is queued once, a re-embed keeps it queued, and a deleted one leaves queue and nodes', () => {
    const [a, b] = [seedMemory('alpha'), seedMemory('beta')];
    saveStoredVectors(home, [[a, [1, 0]], [b, [0, 1]]], 'm');
    saveStoredVectors(home, [[a, [1, 1]]], 'm');
    withDb((db) => {
      expect(pending(db)).toEqual([a, b].sort());
      db.prepare(`INSERT INTO memory_vector_nodes (node, memory_id, level, nbrs) VALUES (0, ?, 0, x'00')`).run(b);
      db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(b);
      expect(pending(db)).toEqual([a]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM memory_vector_nodes').get()).toEqual({ n: 0 });
    });
  });

  it('a failure inside v59 rolls it back whole: schema 58 and no table', () => {
    rewindToV58();
    const up = v59.up;
    const spy = vi.spyOn(v59, 'up').mockImplementation((db, opts) => {
      up(db, opts);
      throw new Error('v59 boom');
    });
    try {
      expect(() => withDb(() => undefined)).toThrow('v59 boom');
    } finally {
      spy.mockRestore();
    }
    const db = openHippoDbReadOnly(home);
    try {
      expect(getSchemaVersion(db)).toBe(58);
      expect(tableExists(db, 'memory_vector_nodes')).toBe(false);
    } finally {
      closeHippoDb(db);
    }
    withDb((d) => expect(getSchemaVersion(d)).toBe(LATEST_SCHEMA_VERSION));
  });
});
