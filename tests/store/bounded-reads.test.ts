// Reads that once took a whole tenant or backlog at a time now come a page at a time and answer the same. Real store.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { tallyAmbientEntries } from '../../src/base/memory/ambient.js';
import { type MemoryEntry } from '../../src/base/memory/memory.js';
import {
  loadEntriesMentioning,
  loadEntryIdsPage,
  selectEntriesFromOrigin,
  selectLiveEntriesBySourcePrefix,
} from '../../src/store/sqlite/entry-reads.js';
import { loadAmbientTallies } from '../../src/store/sqlite/ambient.js';
import { pendingVectorIds, pruneOrphanVectors } from '../../src/store/sqlite/vector-index.js';
import { upsertVectors } from '../../src/db/vector-store.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/rows.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { SleepRows } from '../../src/domain/consolidate/survivors.js';
import { rowsInPages } from '../../src/base/util/pages.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { countMatching, peakRowsRead, recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { seedRows } from '../_helpers/seed-rows.js';
import type { EntryCursor } from '../../src/store/port/types.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const ID_PAGE_READ = 'SELECT id, created FROM memories';

function seeded(root: string, n: number, extra: (i: number) => Partial<MemoryEntry> = () => ({})): MemoryEntry[] {
  return seedRows(
    root,
    n,
    (i) => `row ${i} about the quuxlib client`,
    (i) => ({ created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...extra(i) }),
  );
}

describe('rows that may mention a target', () => {
  it('pages concatenate to the unpaged answer, in order', () => {
    const root = makeRoot('bounded-mentions');
    seeded(root, 11);
    const db = openHippoDb(root);
    try {
      const all = loadEntriesMentioning(db, ['quuxlib'], 'quuxlib', 'default', { limit: 100 });
      expect(all.entries).toHaveLength(11);
      expect(all.next).toBeNull();
      const ids: string[] = [];
      let after;
      let pages = 0;
      do {
        const page = loadEntriesMentioning(db, ['quuxlib'], 'quuxlib', 'default', { limit: 4, after });
        ids.push(...page.entries.map((e) => e.id));
        after = page.next ?? undefined;
        pages++;
      } while (after);
      expect(pages).toBe(3);
      expect(ids).toEqual(all.entries.map((e) => e.id));
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('the FTS check on a read', () => {
  it('issues no COUNT(*) while the in-sync flag holds', () => {
    const root = makeRoot('bounded-fts-flag');
    seeded(root, 3);
    const db = openHippoDb(root);
    try {
      const { statements } = recordStatements(() =>
        loadEntriesMentioning(db, ['quuxlib'], 'ops', 'default', { limit: 100 }),
      );
      expect(countMatching(statements, /COUNT\(\*\)/i)).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('vectors without an index entry', () => {
  it('pages list each pending id once, in id order, and skip those that have a vector', () => {
    const root = makeRoot('bounded-pending');
    const rows = seeded(root, 7);
    const db = openHippoDb(root);
    try {
      upsertVectors(db, [[rows[2].id, [1, 0]]], 'm');
      pruneOrphanVectors(db);
      const ids: string[] = [];
      let afterId: string | undefined;
      do {
        const page = pendingVectorIds(db, { limit: 3, afterId });
        ids.push(...page.ids);
        afterId = page.next ?? undefined;
      } while (afterId !== undefined);
      expect(ids).toEqual(
        rows
          .filter((_, i) => i !== 2)
          .map((r) => r.id)
          .sort(),
      );
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('walks of every row a read names', () => {
  it('list every id one keyset page at a time, in created then id order, each statement bounded by the page', () => {
    const root = makeRoot('bounded-id-pages');
    const rows = seeded(root, 7);
    const db = openHippoDb(root);
    try {
      const log = recordStatements(() => {
        const ids: string[] = [];
        let after: EntryCursor | undefined;
        do {
          const page = loadEntryIdsPage(db, ALL_TENANTS, { limit: 3, after });
          ids.push(...page.ids);
          after = page.next ?? undefined;
        } while (after);
        return ids;
      });
      expect(log.result).toEqual(rows.map((r) => r.id));
      const idReads = log.reads.filter((read) => read.sql.startsWith(ID_PAGE_READ));
      expect(idReads.map((read) => read.rows)).toEqual([4, 4, 1]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('hand sleep its rows one page of ids and then of rows at a time, never every id in one read', async () => {
    const root = makeRoot('bounded-sleep-pages');
    const rows = seeded(root, 7);
    const sleepRows = new SleepRows(sqliteStore(root), new Map(), 3);
    const log = await recordStatementsAsync(async () => {
      const pages: string[][] = [];
      for await (const page of sleepRows.pages()) pages.push(page.map((e) => e.id));
      return pages;
    });
    const ids = rows.map((r) => r.id);
    expect(log.result).toEqual([ids.slice(0, 3), ids.slice(3, 6), ids.slice(6)]);
    expect(peakRowsRead(log.reads, ID_PAGE_READ)).toBe(4);
    expect(peakRowsRead(log.reads, MEMORY_SELECT_COLUMNS)).toBe(3);
  });

  it("walk a tenant's live rows under a prefix and a project's rows a bounded page per statement", () => {
    const root = makeRoot('bounded-tag-walks');
    const rows = seeded(root, 7, (i) => ({
      source: i % 3 === 0 ? 'cli' : `agent-memory:claude-code:p/note-${i}.md`,
      originProject: i === 5 ? 'beta' : 'alpha',
    }));
    const tenant = rows[0].tenantId;
    const db = openHippoDb(root);
    try {
      const imported = recordStatements(() => [
        ...rowsInPages((after?: EntryCursor) =>
          selectLiveEntriesBySourcePrefix(db, tenant, 'agent-memory:', { limit: 2, after }),
        ),
      ]);
      expect(imported.result.map((e) => e.id)).toEqual(rows.filter((_, i) => i % 3 !== 0).map((r) => r.id));
      expect(peakRowsRead(imported.reads, MEMORY_SELECT_COLUMNS)).toBe(3);
      const alpha = recordStatements(() => [
        ...rowsInPages((after?: EntryCursor) =>
          selectEntriesFromOrigin(db, tenant, { origin: 'alpha' }, { limit: 2, after }),
        ),
      ]);
      expect(alpha.result.map((e) => e.id)).toEqual(rows.filter((_, i) => i !== 5).map((r) => r.id));
      expect(peakRowsRead(alpha.reads, MEMORY_SELECT_COLUMNS)).toBe(3);
    } finally {
      closeHippoDb(db);
    }
  });

  it('read nothing past the page the caller asks for', async () => {
    const root = makeRoot('bounded-tag-lazy');
    const rows = seeded(root, 3, () => ({ source: 'agent-memory:claude-code:p/note.md' }));
    const tags = sqliteStore(root).projectTags;
    const log = await recordStatementsAsync(async () => {
      const page = await tags.liveEntriesBySourcePrefix(rows[0].tenantId, 'agent-memory:', { limit: 1 });
      return page.entries[0]?.id;
    });
    expect(log.result).toBe(rows[0].id);
    expect(log.reads.filter((read) => read.sql.includes(MEMORY_SELECT_COLUMNS)).map((r) => r.sql)).toEqual([
      expect.stringMatching(/ORDER BY created ASC, id ASC LIMIT \?$/),
    ]);
  });
});

describe('ambient tag tallies', () => {
  it('count tags in SQL as the row-by-row tally does, repeats and error tags included', () => {
    const root = makeRoot('bounded-ambient');
    const rows = seeded(root, 6, (i) => ({
      tags: i % 3 === 0 ? ['alpha', 'alpha', 'error:db'] : i % 3 === 1 ? ['beta', 'critical'] : ['alpha'],
    }));
    const now = new Date(Date.UTC(2026, 0, 2));
    const db = openHippoDb(root);
    try {
      const sql = loadAmbientTallies(db, {}, 'default', { currentProject: [], now });
      const js = tallyAmbientEntries(rows, now);
      expect(Object.fromEntries(sql.tagCounts)).toEqual(Object.fromEntries(js.tagCounts));
      expect(sql.errors).toBe(js.errors);
      expect(sql.total).toBe(js.total);
    } finally {
      closeHippoDb(db);
    }
  });
});
