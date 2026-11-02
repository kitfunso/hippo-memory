// Per-recall and per-chunk statements are prepared once per handle, not once per call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { pickRarestFtsQuery } from '../../src/store/sqlite/recall/search-rows.js';
import { updateMemoryRows, upsertMemoryRow } from '../../src/store/sqlite/entries/entry-row.js';

let db: DatabaseSyncLike;

beforeEach(() => {
  db = openHippoDb(makeRoot('prepared-reuse'));
});

afterEach(() => {
  vi.restoreAllMocks();
  closeHippoDb(db);
});

describe('prepared statement reuse', () => {
  it('creates each rarest-term vocabulary table once per handle', () => {
    const { statements } = recordStatements(() => {
      pickRarestFtsQuery(db, ['alpha', 'beta']);
      pickRarestFtsQuery(db, ['alpha', '数据库']);
      pickRarestFtsQuery(db, ['delta']);
    });
    const creates = statements.filter((sql) => sql.includes('CREATE VIRTUAL TABLE'));
    expect(creates.filter((sql) => sql.includes('z1_rarest_vocab'))).toHaveLength(1);
    expect(creates.filter((sql) => sql.includes('z1_trigram_vocab'))).toHaveLength(1);
    expect(creates).toHaveLength(2);
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
