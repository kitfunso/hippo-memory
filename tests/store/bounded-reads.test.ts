// Reads that once took a whole tenant or backlog at a time now come a page at a time and answer the same. Real store.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { tallyAmbientEntries } from '../../src/core/ambient.js';
import { DEFAULT_HALF_LIFE_DAYS, createMemory, type MemoryEntry } from '../../src/core/memory.js';
import { loadEntriesMentioningAt } from '../../src/store/entry-reads.js';
import { loadAmbientTalliesAt } from '../../src/store/ambient.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { pendingVectorIdsAt, pruneOrphanVectorsAt } from '../../src/store/vector-index.js';
import { saveStoredVectorsAt } from '../../src/store/vector-index.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';

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
      const { statements } = recordStatements(() => loadEntriesMentioningAt(db, ['quuxlib'], 'ops', undefined, { limit: 100 }));
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

describe('ambient tag tallies', () => {
  it('count tags in SQL as the row-by-row tally does, repeats and error tags included', () => {
    const root = makeRoot('bounded-ambient');
    const rows = seeded(root, 6, (i) => ({ tags: i % 3 === 0 ? ['alpha', 'alpha', 'error:db'] : i % 3 === 1 ? ['beta', 'critical'] : ['alpha'] }));
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
