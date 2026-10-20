// The id-list read and the rarest-term read prepare their SQL once per handle, however many requests run on it.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { loadEntriesByIdsAt } from '../../src/store/sqlite/entry-reads.js';
import { pickRarestFtsQuery } from '../../src/store/sqlite/search-rows.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string;
let db: DatabaseSyncLike;
let prepare: MockInstance<DatabaseSyncLike['prepare']>;

const preparedOf = (text: string): number => prepare.mock.calls.filter(([sql]) => sql.includes(text)).length;

beforeEach(() => {
  root = makeRoot('hot-prepares');
  db = openHippoDb(root);
  prepare = vi.spyOn(db, 'prepare');
});

afterEach(() => {
  prepare.mockRestore();
  closeHippoDb(db);
  rmSync(root, { recursive: true, force: true });
});

describe('hot read statements', () => {
  it('loadEntriesByIdsAt prepares one statement for every id-list length and reuses it', () => {
    const ids = ['a', 'b', 'c'].map((id) => {
      const entry = { ...createMemory(`row ${id}`, { baseHalfLifeDays: 30 }), id };
      writeEntryDbOnly(db, entry);
      return entry.id;
    });

    for (let i = 0; i < 4; i++) expect(loadEntriesByIdsAt(db, ids, 'default').map((e) => e.id)).toHaveLength(3);
    loadEntriesByIdsAt(db, ids.slice(0, 2), 'default');

    expect(preparedOf('FROM memories WHERE id IN')).toBe(1);
  });

  it('pickRarestFtsQuery prepares its vocabulary read once for the same term count', () => {
    writeEntryDbOnly(db, { ...createMemory('kafka redis cache', { baseHalfLifeDays: 30 }), id: 'k' });

    for (let i = 0; i < 4; i++) pickRarestFtsQuery(db, ['kafka', 'redis']);

    expect(preparedOf('z1_rarest_vocab WHERE term IN')).toBe(1);
  });
});
