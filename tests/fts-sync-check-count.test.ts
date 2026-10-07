// backfillFtsIndex counted the FTS5 virtual table itself on every open,
// walking every document. Real SQLite store, no mocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadSearchEntries } from '../src/store/search-rows.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { repairFtsDrift } from '../src/db/migrate.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; mirrors tests/db-open-write-free.test.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: { prepare: (sql: string) => object } };
};

const FTS_COUNT = /COUNT\(\*\)[\s\S]*FROM memories_fts(?!_)/i;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-f2-fts-count-'));
  initStore(root);
  writeEntry(root, createMemory('a distinctive gribblesnort memory row for the fts count test', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('FTS sync check does not count the virtual table itself', () => {
  it('opening an initialised store issues no COUNT(*) against memories_fts', () => {
    const statements: string[] = [];
    const originalPrepare = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSyncLike,
      ...args: [string]
    ) {
      statements.push(args[0]);
      return originalPrepare.apply(this, args);
    });
    try {
      const db = openHippoDb(root);
      closeHippoDb(db);
    } finally {
      spy.mockRestore();
    }

    expect(statements.some((sql) => FTS_COUNT.test(sql))).toBe(false);
  });

  it('still heals a store whose fts row drifted out from under it', () => {
    const db = openHippoDb(root);
    db.prepare(`DELETE FROM memories_fts WHERE content LIKE '%gribblesnort%'`).run();
    closeHippoDb(db);

    const found = loadSearchEntries(root, 'gribblesnort', 10);

    expect(found.some((e) => e.content.includes('gribblesnort'))).toBe(true);
  });
});

describe('FTS drift repair', () => {
  // `id` is UNINDEXED in memories_fts, so a per-row lookup scans the whole index and the repair grows with the square of the store.
  it('heals one missing row in a 10,000-row store in under a second', () => {
    const db = openHippoDb(root);
    try {
      // SAFETY: pragma_table_info yields one row per column with its name.
      const columns = (db.prepare(`SELECT name FROM pragma_table_info('memories') WHERE name != 'id'`).all() as Array<{ name: string }>).map((c) => c.name);
      db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
        INSERT INTO memories(id, ${columns.join(', ')}) SELECT 'mem_bulk_' || n.i, ${columns.join(', ')} FROM memories, n;
        DELETE FROM memories_fts;
        INSERT INTO memories_fts(id, content, tags) SELECT id, content, tags_json FROM memories;
        DELETE FROM memories_fts WHERE id = 'mem_bulk_5000';
      `);

      const started = performance.now();
      expect(repairFtsDrift(db)).toBe(true);
      const elapsed = performance.now() - started;

      // SAFETY: both SELECTs return one COUNT(*) AS c row.
      const missing = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE id NOT IN (SELECT id FROM memories_fts)`).get() as { c: number };
      expect(Number(missing.c)).toBe(0);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      closeHippoDb(db);
    }
  });
});
