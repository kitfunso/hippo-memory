// Full walks read an index in order, so no page sorts the table, and a walk over many ties on created hands back each
// row once, in the pages the one sorted query over every row gives. Real store.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { DEFAULT_HALF_LIFE_DAYS, createMemory, type MemoryEntry } from '../../src/base/memory/memory.js';
import {
  loadEntriesMentioningAt,
  loadEntriesPageAt,
  loadEntriesWithSignalsAt,
  loadEntryIdsByIdAt,
  loadEntryIdsPageAt,
  loadEntryTextKeysPageAt,
  selectEntriesFromOriginAt,
  selectLiveEntriesBySourcePrefix,
  selectTenantTextsPage,
} from '../../src/store/sqlite/entry-reads.js';
import { pendingVectorIdsAt, resetStoredParticlesAt } from '../../src/store/sqlite/vector-index.js';
import { upsertVectors } from '../../src/db/vector-store.js';
import { ALL_TENANTS, type TenantId } from '../../src/base/util/tenant.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import type { EntryCursor } from '../../src/store/port/types.js';

const CREATED = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2026-01-02T00:00:00.000Z'];
const SORT_OF_ORDER = 'USE TEMP B-TREE FOR ORDER BY';
const SIGNALS = { tags: ['quux'], sourcePrefix: 'cli', minRetrievals: 0, valences: ['neutral'] };

interface IdsPage<C> {
  readonly ids: readonly string[];
  readonly next: C | null;
}

/** Every page of a walk, `read` given the cursor the page before ended at. */
function pagesOf<C>(read: (after: C | undefined) => IdsPage<C>): string[][] {
  const pages: string[][] = [];
  let after: C | undefined;
  do {
    const page = read(after);
    pages.push([...page.ids]);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return pages;
}

const entryIds = (page: { entries: MemoryEntry[]; next: EntryCursor | null }): IdsPage<EntryCursor> => ({
  ids: page.entries.map((e) => e.id),
  next: page.next,
});

/** Each walk a store pass makes, three rows a page, for `tenantId` where it takes one. */
function walks(db: DatabaseSyncLike, tenantId: TenantId) {
  const tenant = tenantId === ALL_TENANTS ? 'default' : tenantId;
  const page = (after?: EntryCursor) => ({ limit: 3, after });
  return {
    entryIds: () => pagesOf((after?: EntryCursor) => loadEntryIdsPageAt(db, tenantId, page(after))),
    entries: () => pagesOf((after?: EntryCursor) => entryIds(loadEntriesPageAt(db, tenantId, page(after)))),
    textKeys: () =>
      pagesOf((after?: EntryCursor) => {
        const keys = loadEntryTextKeysPageAt(db, tenantId, page(after));
        return { ids: keys.keys.map((k) => k.id), next: keys.next };
      }),
    signals: () =>
      pagesOf((after?: EntryCursor) => entryIds(loadEntriesWithSignalsAt(db, SIGNALS, tenantId, page(after)))),
    mentions: () =>
      pagesOf((after?: EntryCursor) => entryIds(loadEntriesMentioningAt(db, ['quux'], 'quux', tenantId, page(after)))),
    tenantTexts: () =>
      pagesOf((after?: EntryCursor) => {
        const texts = selectTenantTextsPage(db, tenant, page(after));
        return { ids: texts.texts.map((t) => t.id), next: texts.next };
      }),
    sourcePrefix: () =>
      pagesOf((after?: EntryCursor) => entryIds(selectLiveEntriesBySourcePrefix(db, tenant, 'cli', page(after)))),
    origin: () =>
      pagesOf((after?: EntryCursor) =>
        entryIds(selectEntriesFromOriginAt(db, tenant, { origin: '', live: true }, page(after))),
      ),
    idOrder: () => pagesOf((afterId?: string) => loadEntryIdsByIdAt(db, { limit: 3, afterId })),
    pendingVectors: () => pagesOf((afterId?: string) => pendingVectorIdsAt(db, { limit: 3, afterId })),
    particleReset: () => [[String(resetStoredParticlesAt(db, {}))]],
  };
}

function seed(root: string, entries: readonly MemoryEntry[]): void {
  writeEntriesTogether(root, entries);
}

function row(i: number, tenantId: string, created: string, id?: string): MemoryEntry {
  const entry = createMemory(`row ${i} about the quux client`, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tenantId,
    tags: ['quux'],
  });
  return { ...entry, created, source: 'cli', id: id ?? entry.id };
}

function plan(db: DatabaseSyncLike, sql: string): string {
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

describe('a full walk', () => {
  it('reads every page off an index: no statement sorts the rows for its ORDER BY', () => {
    const root = makeRoot('keyset-walk-plans');
    const rows = Array.from({ length: 10 }, (_, i) => row(i, i % 2 === 0 ? 'default' : 'other', CREATED[i % 3]!));
    seed(root, rows);
    const db = openHippoDb(root);
    try {
      upsertVectors(db, [[rows[0]!.id, [1, 0]]], 'm');
      // The detector is live: the old cross-tenant read sorts every row for each page.
      expect(plan(db, 'SELECT id, created FROM memories ORDER BY created ASC, id ASC LIMIT ?')).toContain(
        SORT_OF_ORDER,
      );
      for (const tenantId of [ALL_TENANTS, 'default'] as const) {
        for (const [name, walk] of Object.entries(walks(db, tenantId))) {
          const { statements } = recordStatements(walk);
          const reads = statements.filter((sql) => /^(SELECT|WITH)\b/.test(sql) && sql.includes('FROM memories'));
          expect(reads.length, name).toBeGreaterThan(0);
          for (const sql of reads) expect(plan(db, sql), `${name}: ${sql}`).not.toContain(SORT_OF_ORDER);
        }
      }
    } finally {
      closeHippoDb(db);
    }
  });
});

/** mulberry32: the same rows on every run, so a failure replays. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ids past U+FFFF and between U+E000 and U+FFFF sort one way by UTF-16 unit and the other by SQLite's UTF-8 bytes.
const ODD_IDS = ['id-\u{1F600}', 'id-Ａ', 'id-a', 'id-é'];

/** The pages the one sorted query over every row gives: what each walk page held before the walks read the index. */
function sortedPages(db: DatabaseSyncLike, limit: number, tenantId?: string): string[][] {
  const tenant = tenantId === undefined ? '' : ' AND tenant_id = ?';
  const sql = `SELECT id, created FROM memories WHERE (created, id) > (?, ?)${tenant} ORDER BY created, id LIMIT ?`;
  const pages: string[][] = [];
  let after = { created: '', id: '' };
  for (;;) {
    const args = tenantId === undefined ? [limit] : [tenantId, limit];
    // SAFETY: the SELECT names both columns.
    const rows = db.prepare(sql).all(after.created, after.id, ...args) as Array<{ id: string; created: string }>;
    if (rows.length === 0) return pages.length === 0 ? [[]] : pages;
    pages.push(rows.map((r) => r.id));
    after = rows[rows.length - 1]!;
    if (rows.length < limit) return pages;
  }
}

describe('a walk over many ties on created', () => {
  it('returns every row exactly once, each page holding what the sorted query gives', () => {
    for (let trial = 0; trial < 8; trial++) {
      const next = random(trial + 1);
      const tenants = 1 + (trial % 4);
      const n = 15 + Math.floor(next() * 30);
      const rows = Array.from({ length: n }, (_, i) =>
        row(
          i,
          `t${Math.floor(next() * tenants)}`,
          CREATED[Math.floor(next() * CREATED.length)]!,
          i < ODD_IDS.length ? `${ODD_IDS[i]}-${trial}` : undefined,
        ),
      );
      const root = makeRoot(`keyset-walk-ties-${trial}`);
      seed(root, rows);
      const db = openHippoDb(root);
      try {
        const limit = 1 + Math.floor(next() * 6);
        const walked = pagesOf((after?: EntryCursor) => loadEntryIdsPageAt(db, ALL_TENANTS, { limit, after }));
        expect(walked, `trial ${trial}`).toEqual(sortedPages(db, limit));
        expect(new Set(walked.flat()).size).toBe(n);
        const tenant = rows[0]!.tenantId;
        const inTenant = pagesOf((after?: EntryCursor) => entryIds(loadEntriesPageAt(db, tenant, { limit, after })));
        expect(inTenant).toEqual(sortedPages(db, limit, tenant));
        const byId = pagesOf((afterId?: string) => loadEntryIdsByIdAt(db, { limit, afterId })).flat();
        // SAFETY: one TEXT column.
        const ids = db.prepare('SELECT id FROM memories ORDER BY id').all() as Array<{ id: string }>;
        expect(byId).toEqual(ids.map((r) => r.id));
        expect(new Set(byId).size).toBe(n);
      } finally {
        closeHippoDb(db);
      }
    }
  });
});
