// Reads that once took a whole tenant or backlog at a time now come a page at a time and answer the same. Real store.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { tallyAmbientEntries } from '../../src/core/ambient.js';
import { DEFAULT_HALF_LIFE_DAYS, createMemory, type MemoryEntry } from '../../src/core/memory.js';
import {
  loadEntriesMentioningAt,
  loadEntryIdsPageAt,
  selectEntriesFromOriginAt,
  selectLiveEntriesBySourcePrefix,
} from '../../src/store/sqlite/entry-reads.js';
import { loadAmbientTalliesAt } from '../../src/store/sqlite/ambient.js';
import { pendingVectorIdsAt, pruneOrphanVectorsAt } from '../../src/store/sqlite/vector-index.js';
import { saveStoredVectorsAt } from '../../src/store/sqlite/vector-index.js';
import { projectTagReads } from '../../src/store/sqlite/project-tags.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/rows.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import type { EntryCursor } from '../../src/store/port/consolidation.js';
import { SleepRows } from '../../src/consolidate/survivors.js';
import { rowsInPages } from '../../src/util/pages.js';
import { countMatching, peakRowsRead, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

const ID_PAGE_READ = 'SELECT id, created FROM memories';

function seeded(root: string, n: number, extra: (i: number) => Partial<MemoryEntry> = () => ({})): MemoryEntry[] {
  const rows = Array.from({ length: n }, (_, i) => ({
    ...createMemory(`row ${i} about the quuxlib client`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    ...extra(i),
  }));
  for (const row of rows) writeEntry(root, row);
  return rows;
}

describe('rows that may mention a target', () => {
  it('pages concatenate to the unpaged answer, in order', () => {
    const root = makeRoot('bounded-mentions');
    seeded(root, 11);
    const db = openHippoDb(root);
    try {
      const all = loadEntriesMentioningAt(db, ['quuxlib'], 'quuxlib', undefined, { limit: 100 });
      expect(all.entries).toHaveLength(11);
      expect(all.next).toBeNull();
      const ids: string[] = [];
      let after;
      let pages = 0;
      do {
        const page = loadEntriesMentioningAt(db, ['quuxlib'], 'quuxlib', undefined, { limit: 4, after });
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
        loadEntriesMentioningAt(db, ['quuxlib'], 'ops', undefined, { limit: 100 }),
      );
      expect(countMatching(statements, /COUNT\(\*\)/i)).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('vectors without an index entry', () => {
  it('pages list each pending id once, oldest first, and skip those that have a vector', () => {
    const root = makeRoot('bounded-pending');
    const rows = seeded(root, 7);
    const db = openHippoDb(root);
    try {
      saveStoredVectorsAt(db, [[rows[2].id, [1, 0]]], 'm');
      pruneOrphanVectorsAt(db);
      const ids: string[] = [];
      let after;
      do {
        const page = pendingVectorIdsAt(db, { limit: 3, after });
        ids.push(...page.ids);
        after = page.next ?? undefined;
      } while (after);
      expect(ids).toEqual(rows.filter((_, i) => i !== 2).map((r) => r.id));
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
          const page = loadEntryIdsPageAt(db, { limit: 3, after });
          ids.push(...page.ids);
          after = page.next ?? undefined;
        } while (after);
        return ids;
      });
      expect(log.result).toEqual(rows.map((r) => r.id));
      expect(log.reads.map((read) => read.rows)).toEqual([4, 4, 1]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('hand sleep its rows one page of ids and then of rows at a time, never every id in one read', () => {
    const root = makeRoot('bounded-sleep-pages');
    const rows = seeded(root, 7);
    const sleepRows = new SleepRows(sqliteSyncStore(root).localFiles.consolidation, new Map(), 3);
    const log = recordStatements(() => [...sleepRows.pages()].map((page) => page.map((e) => e.id)));
    const ids = rows.map((r) => r.id);
    expect(log.result).toEqual([ids.slice(0, 3), ids.slice(3, 6), ids.slice(6)]);
    expect(peakRowsRead(log.reads, ID_PAGE_READ)).toBe(4);
    expect(peakRowsRead(log.reads, MEMORY_SELECT_COLUMNS)).toBe(3);
  });

  it("walk a tenant's live rows under a prefix and a project's rows a bounded page per statement", () => {
    const root = makeRoot('bounded-tag-walks');
    const rows = seeded(root, 7, (i) => ({
      source: i % 3 === 0 ? 'cli' : `agent-memory:claude-code:p/note-${i}.md`,
      origin_project: i === 5 ? 'beta' : 'alpha',
    }));
    const tenant = rows[0].tenant_id;
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
          selectEntriesFromOriginAt(db, tenant, { origin: 'alpha' }, { limit: 2, after }),
        ),
      ]);
      expect(alpha.result.map((e) => e.id)).toEqual(rows.filter((_, i) => i !== 5).map((r) => r.id));
      expect(peakRowsRead(alpha.reads, MEMORY_SELECT_COLUMNS)).toBe(3);
    } finally {
      closeHippoDb(db);
    }
  });

  it('read nothing past the first page when the caller stops walking', () => {
    const root = makeRoot('bounded-tag-lazy');
    const rows = seeded(root, 3, () => ({ source: 'agent-memory:claude-code:p/note.md' }));
    const db = openHippoDb(root);
    try {
      const walk = projectTagReads(db, rows[0].tenant_id).liveEntriesBySourcePrefix('agent-memory:');
      const log = recordStatements(() => walk[Symbol.iterator]().next().value?.id);
      expect(log.result).toBe(rows[0].id);
      expect(log.reads.filter((read) => read.sql.includes(MEMORY_SELECT_COLUMNS)).map((r) => r.sql)).toEqual([
        expect.stringMatching(/ORDER BY created ASC, id ASC LIMIT \?$/),
      ]);
    } finally {
      closeHippoDb(db);
    }
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
      const sql = loadAmbientTalliesAt(db, 'default', { currentProject: [], now });
      const js = tallyAmbientEntries(rows, now);
      expect(Object.fromEntries(sql.tagCounts)).toEqual(Object.fromEntries(js.tagCounts));
      expect(sql.errors).toBe(js.errors);
      expect(sql.total).toBe(js.total);
    } finally {
      closeHippoDb(db);
    }
  });
});
