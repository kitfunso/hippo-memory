// Only a missing fts5 module may mark full-text search unavailable; a busy or locked open must leave the flag alone.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { getMeta } from '../src/db/meta.js';
import { MEMORIES_FTS_DDL } from '../src/db/continuity.js';
import { runMigrations } from '../src/db/migrate.js';
import type { DatabaseSyncLike } from '../src/db/sqlite.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; this cast mirrors src/db/sqlite.ts's boundary.
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncLike };

/** A migrated in-memory store with the flag at '1'; `failFtsWith` makes the next full-text DDL throw, and a deleted meta default forces the slow open path. */
function healthyStore() {
  const raw = new DatabaseSync(':memory:');
  let message: string | null = null;
  const db: DatabaseSyncLike = {
    exec: (sql) => {
      if (sql === MEMORIES_FTS_DDL && message !== null) throw new Error(message);
      raw.exec(sql);
    },
    prepare: (sql) => raw.prepare(sql),
    close: () => raw.close(),
  };
  runMigrations(db);
  expect(getMeta(db, 'fts5_available')).toBe('1');
  raw.exec(`DELETE FROM meta WHERE key = 'total_recalled'`);
  return { db, failFtsWith: (m: string) => (message = m) };
}

afterEach(() => vi.restoreAllMocks());

describe('the fts5_available flag on open', () => {
  it('stays 1 when the full-text DDL fails because the database is locked', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { db, failFtsWith } = healthyStore();
    failFtsWith('database is locked');
    runMigrations(db);
    expect(getMeta(db, 'fts5_available')).toBe('1');
  });

  it('becomes 0 when the fts5 module is missing', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { db, failFtsWith } = healthyStore();
    failFtsWith('no such module: fts5');
    runMigrations(db);
    expect(getMeta(db, 'fts5_available')).toBe('0');
  });
});
