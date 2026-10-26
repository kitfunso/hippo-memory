// Per-recall and per-chunk statements are prepared once per handle, not once per call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { pickRarestFtsQuery } from '../../src/store/sqlite/search-rows.js';
import { updateMemoryRows, upsertMemoryRow } from '../../src/store/sqlite/entry-row.js';

let db: DatabaseSyncLike;

beforeEach(() => {
  db = openHippoDb(makeRoot('prepared-reuse'));
});

afterEach(() => {
  vi.restoreAllMocks();
  closeHippoDb(db);
});

describe('prepared statement reuse', () => {
  it('creates the rarest-term vocabulary table once per handle', () => {
    const { statements } = recordStatements(() => {
      pickRarestFtsQuery(db, ['alpha', 'beta']);
      pickRarestFtsQuery(db, ['alpha', 'gamma']);
      pickRarestFtsQuery(db, ['delta']);
    });
    expect(statements.filter((sql) => sql.includes('CREATE VIRTUAL TABLE'))).toHaveLength(1);
  });

  it('prepares the multi-row memory UPDATE once for repeated chunks of one size', () => {
    const entries = [1, 2, 3].map((i) => ({ ...createMemory(`row ${i}`), id: `mem_u${i}` }));
    for (const e of entries) upsertMemoryRow(db, e);
    updateMemoryRows(db, entries);
    const prepare = vi.spyOn(Object.getPrototypeOf(db), 'prepare');
    db.prepare('SELECT 1');
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    updateMemoryRows(db, entries);
    updateMemoryRows(db, entries);
    expect(prepare.mock.calls.filter(([sql]) => String(sql).includes('UPDATE memories SET'))).toHaveLength(0);
  });
});
