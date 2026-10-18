// The per-handle statement cache drops its least recently used statement when full, never the whole cache.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { cachedStatement } from '../../src/store/statement-cache.js';
import { makeRoot } from '../_helpers/make-root.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement.
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: { prototype: { prepare(sql: string): object } } };

// The cache's cap; a test of eviction has to fill it.
const CAP = 32;
const sql = (n: number): string => `SELECT ${n} AS n`;

let db: DatabaseSyncLike;
beforeEach(() => {
  db = openHippoDb(makeRoot('statement-cache'));
});
afterEach(() => closeHippoDb(db));

function preparesFor(fn: () => void): string[] {
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
  try {
    fn();
    return prepare.mock.calls.map(([text]) => text);
  } finally {
    prepare.mockRestore();
  }
}

describe('cachedStatement', () => {
  it('keeps a recently used statement when a new one overflows the cache, and evicts the oldest', () => {
    const first = preparesFor(() => {
      for (let n = 0; n < CAP; n++) cachedStatement(db, sql(n)).get();
    });
    expect(first).toHaveLength(CAP);

    const after = preparesFor(() => {
      cachedStatement(db, sql(0)).get();
      cachedStatement(db, sql(CAP)).get();
      cachedStatement(db, sql(0)).get();
      for (let n = 2; n < CAP; n++) cachedStatement(db, sql(n)).get();
      cachedStatement(db, sql(1)).get();
    });

    expect(after).toEqual([sql(CAP), sql(1)]);
  });

  it('hands back the same statement for the same text on one handle', () => {
    expect(cachedStatement(db, sql(7))).toBe(cachedStatement(db, sql(7)));
  });
});
