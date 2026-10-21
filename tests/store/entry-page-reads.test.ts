// Two page reads in loadAllEntries' order: the mention read's FTS hits and non-ASCII rows, read apart and joined in JS,
// page as the one OR statement did; and a page over every tenant is one statement however many tenants there are.
import { afterEach, describe, expect, it } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/base/memory/memory.js';
import { ALL_TENANTS, type TenantId } from '../../src/base/util/tenant.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { loadEntriesMentioningAt, loadEntryIdsPageAt } from '../../src/store/sqlite/entry-reads.js';
import type { EntryCursor } from '../../src/store/port/types.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

oneRequestPerTest();

const TEXTS = [
  'the quuxlib client retries twice',
  'an unrelated note on billing',
  'le café runs quuxlib at noon',
  'a naïve note with no match',
  'the release notes for friday',
];
const T0 = Date.parse('2026-02-01T00:00:00.000Z');

const opened: DatabaseSyncLike[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeHippoDb(db);
});

// Rows share a `created` in threes, so the id settles ties at page edges; every fifth row is tagged quuxlib.
function seeded(rows: number, tenants: number): DatabaseSyncLike {
  const root = makeRoot('entry-page-reads');
  const entries: MemoryEntry[] = Array.from({ length: rows }, (_, i) => ({
    ...createMemory(`${TEXTS[i % TEXTS.length]} ${i}`, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: i % 5 === 4 ? ['quuxlib'] : ['ops'],
    }),
    id: `row-${String((i * 7) % rows).padStart(3, '0')}`,
    tenantId: `t${i % tenants}`,
    created: new Date(T0 + Math.floor(i / 3) * 60_000).toISOString(),
  }));
  writeEntriesTogether(root, entries);
  const db = openHippoDb(root);
  opened.push(db);
  return db;
}

// The one statement the mention read ran before the split, for the same MATCH its FTS path builds.
function oneOrStatement(db: DatabaseSyncLike, tenantId: TenantId): string[] {
  const tenant = tenantId === ALL_TENANTS ? '' : ' AND tenant_id = ?';
  const nonAscii = (c: string): string => `length(${c}) != length(CAST(${c} AS BLOB))`;
  const sql =
    `SELECT id FROM memories WHERE (id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?) OR ` +
    `${nonAscii('content')} OR ${nonAscii('tags_json')})${tenant} ORDER BY created, id`;
  const args = tenantId === ALL_TENANTS ? [] : [tenantId];
  // SAFETY: the SELECT names one TEXT column.
  return (db.prepare(sql).all('"quuxlib" OR tags : "quuxlib"', ...args) as Array<{ id: string }>).map((r) => r.id);
}

function mentionWalk(db: DatabaseSyncLike, tenantId: TenantId, limit: number): string[] {
  const ids: string[] = [];
  let after: EntryCursor | undefined;
  do {
    const page = loadEntriesMentioningAt(db, ['quuxlib'], 'quuxlib', tenantId, { limit, after });
    ids.push(...page.entries.map((e) => e.id));
    after = page.next ?? undefined;
  } while (after !== undefined);
  return ids;
}

describe('the mention read over ASCII and non-ASCII rows', () => {
  it.each([1, 3, 7, 100])('pages, %i rows a page, as the one OR statement ordered them', (limit) => {
    const db = seeded(60, 3);
    for (const tenantId of [ALL_TENANTS, 't1'] as const) {
      const expected = oneOrStatement(db, tenantId);
      expect(expected.length).toBeGreaterThan(limit === 100 ? 0 : limit);
      const { result, statements } = recordStatements(() => mentionWalk(db, tenantId, limit));
      expect(result).toEqual(expected);
      // The FTS path ran, not the LIKE fallback.
      expect(countMatching(statements, 'memories_fts MATCH')).toBeGreaterThan(0);
    }
  });
});

describe('a page over every tenant', () => {
  it.each([1, 6])('is one statement over %i tenants', (tenants) => {
    const db = seeded(30, tenants);
    const { result, statements } = recordStatements(() => loadEntryIdsPageAt(db, ALL_TENANTS, { limit: 4 }));
    expect(countMatching(statements, 'FROM memories')).toBe(1);
    expect(result.ids).toHaveLength(4);
  });
});
