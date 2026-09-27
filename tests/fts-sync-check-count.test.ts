// backfillFtsIndex counted the FTS5 virtual table itself on every open,
// walking every document. Real SQLite store, no mocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { initStore, writeEntry, loadSearchEntries } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';

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
  writeEntry(root, createMemory('a distinctive gribblesnort memory row for the fts count test'));
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
