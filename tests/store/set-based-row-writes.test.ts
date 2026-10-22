// The half-life move and the project stamp write any number of rows in one statement, with the values a row-by-row
// write leaves, a repeated id taking its last value.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { setHalfLives, stampOriginProjects } from '../../src/store/sqlite/entry-writes.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { recordStatements } from '../_helpers/count-statements.js';

const SIZES = [10, 200] as const;

function seeded(n: number, tenantId = 'default') {
  const root = makeStore('set-based-writes').root;
  const rows = Array.from({ length: n }, (_, i) => createMemory(`row ${i} of the set write`, { tenantId }));
  writeEntriesTogether(root, rows);
  return { root, rows };
}

function onDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function column(root: string, name: 'half_life_days' | 'origin_project'): Map<string, unknown> {
  // SAFETY: the SELECT names id and one column, read back as `value`.
  const rows = onDb(root, (db) => db.prepare(`SELECT id, ${name} AS value FROM memories`).all()) as Array<{
    id: string;
    value: unknown;
  }>;
  return new Map(rows.map((r) => [r.id, r.value]));
}

const updates = (statements: readonly string[]) => statements.filter((sql) => /^\s*(WITH|UPDATE)\b/.test(sql));

describe('setHalfLives', () => {
  it.each(SIZES)('writes %i rows in one statement, the last value of a repeated id winning', (n) => {
    const { root, rows } = seeded(n);
    const moves = rows.map((r, i) => ({ id: r.id, halfLifeDays: 1.5 + i / 7 }));
    moves.push({ id: rows[0].id, halfLifeDays: 42.25 });
    const { statements } = recordStatements(() => onDb(root, (db) => setHalfLives(db, moves)));
    expect(updates(statements)).toHaveLength(1);
    const want = new Map(moves.map((m) => [m.id, m.halfLifeDays]));
    expect(column(root, 'half_life_days')).toEqual(want);
  });

  it('writes nothing for no rows', () => {
    const { root } = seeded(1);
    const before = column(root, 'half_life_days');
    const { statements } = recordStatements(() => onDb(root, (db) => setHalfLives(db, [])));
    expect(updates(statements)).toEqual([]);
    expect(column(root, 'half_life_days')).toEqual(before);
  });
});

describe('stampOriginProjects', () => {
  it.each(SIZES)('stamps %i rows in one statement, in the tenant only', (n) => {
    const { root, rows } = seeded(n);
    const foreign = createMemory('another tenant keeps its project', { tenantId: 'acme' });
    writeEntriesTogether(root, [foreign]);
    const before = column(root, 'origin_project');
    const stamps = rows.map((r, i) => ({ id: r.id, origin: i % 2 === 0 ? 'alpha' : '' }));
    stamps.push({ id: rows[0].id, origin: 'beta' }, { id: foreign.id, origin: 'alpha' });
    const { statements } = recordStatements(() => onDb(root, (db) => stampOriginProjects(db, 'default', stamps)));
    expect(updates(statements)).toHaveLength(1);
    const want = new Map<string, unknown>(stamps.filter((s) => s.id !== foreign.id).map((s) => [s.id, s.origin]));
    want.set(foreign.id, before.get(foreign.id));
    expect(column(root, 'origin_project')).toEqual(want);
  });
});
