// The strength aggregates bind the clock, so a call at any `now` reuses one cached statement and sums as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { strengthSql } from '../../src/store/sqlite/rule-sql.js';
import { strengthTalliesAt } from '../../src/store/sqlite/candidates.js';
import { loadAmbientTalliesAt } from '../../src/store/sqlite/ambient.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: { prototype: { prepare(sql: string): object } };
};

const TENANT = 'default';
const EARLY = new Date('2026-06-01T00:00:00.000Z');
const LATE = new Date('2026-06-20T12:34:56.789Z');

function row(content: string, daysBefore: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const at = new Date(EARLY.getTime() - daysBefore * 86_400_000).toISOString();
  return { ...createMemory(content, { tenantId: TENANT }), created: at, validFrom: at, lastRetrieved: at, ...extra };
}

/** The sum the old text gave, with the clock written into the SQL as a literal. */
function literalClockSum(db: DatabaseSyncLike, now: Date): number {
  const { sql, params } = strengthSql(now, {});
  expect(params).toHaveLength(1);
  const julian = params[0]!;
  const literal = Number.isInteger(julian) ? julian.toFixed(1) : String(julian);
  const text = `SELECT COALESCE(SUM(COALESCE(${sql.replace('?', literal)}, 0)), 0) AS s FROM memories WHERE tenant_id = ?`;
  // SAFETY: an aggregate with no GROUP BY answers one row with the column s.
  return (db.prepare(text).get(TENANT) as { s: number }).s;
}

let db: DatabaseSyncLike;
let rowCount: number;
beforeEach(() => {
  const root = makeRoot('strength-bound');
  const rows = [
    row('fresh note', 1),
    row('older note', 20, { retrievalCount: 3 }),
    row('pinned note', 40, { pinned: true }),
    row('wrong note', 5, { outcomeNegative: 2 }),
    row('critical note', 9, { emotionalValence: 'critical' }),
    row('short half-life', 3, { halfLifeDays: 2 }),
  ];
  writeEntriesTogether(root, rows);
  rowCount = rows.length;
  db = openHippoDb(root);
});
afterEach(() => closeHippoDb(db));

/** What `fn` returns, and the text of each statement it prepared. */
function prepares<T>(fn: () => T) {
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare');
  try {
    const result = fn();
    return { result, texts: spy.mock.calls.map(([text]) => text) };
  } finally {
    spy.mockRestore();
  }
}

describe('the strength aggregates', () => {
  it('prepare one statement each for two clocks, and sum what the literal clock summed', () => {
    const { result, texts } = prepares(() => ({
      tallies: [EARLY, LATE].map((now) => strengthTalliesAt(db, {}, TENANT, now, 0.3)),
      ambient: [EARLY, LATE].map((now) => loadAmbientTalliesAt(db, {}, TENANT, { currentProject: [], now })),
    }));
    expect(texts.filter((text) => text.includes('AS strengthSum'))).toHaveLength(2);
    const literal = [EARLY, LATE].map((now) => literalClockSum(db, now));
    expect(result.tallies.map((t) => t.strengthSum)).toEqual(literal);
    expect(result.ambient.map((a) => a.total)).toEqual([rowCount, rowCount]);
    expect(result.ambient.map((a) => a.strengthSum)).toEqual(literal);
    expect(literal[1]).toBeLessThan(literal[0]!);
  });
});
