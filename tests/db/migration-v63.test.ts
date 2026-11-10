// Schema v63 stores "no successor" one way: it clears a blank superseded_by link and leaves every other row as stored.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, getSchemaVersion, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { v63 } from '../../src/db/migrations/v63.js';
import { MEMORY_KINDS } from '../../src/base/memory/entry.js';
import { initStore } from '../../src/store/sqlite/runtime/handles.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

const KIND_TRIGGERS = ['trg_memories_kind_check_insert', 'trg_memories_kind_check_update'];
const FIXED_UPDATED_AT = '2020-01-01 00:00:00';

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Every column of every row but the link, updated_at included. */
function rowsWithoutLink(db: DatabaseSyncLike): unknown[] {
  // SAFETY: the SELECT names one TEXT column, name.
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('memories') WHERE name != 'superseded_by'`)
    .all() as Array<{ name: string }>;
  return db.prepare(`SELECT ${columns.map((column) => column.name).join(', ')} FROM memories ORDER BY id`).all();
}

/** The stored link of each row, by id. */
function links(db: DatabaseSyncLike): Record<string, string | null> {
  // SAFETY: the SELECT names both columns, id and superseded_by.
  const rows = db.prepare('SELECT id, superseded_by FROM memories').all() as Array<{
    id: string;
    superseded_by: string | null;
  }>;
  return Object.fromEntries(rows.map((row) => [row.id, row.superseded_by]));
}

function triggerNames(db: DatabaseSyncLike): string[] {
  // SAFETY: the SELECT names one TEXT column, name.
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

/** Takes a current store back to v62: both versions stamped 62, so the next open runs v63. */
function toV62(db: DatabaseSyncLike): void {
  setMeta(db, 'schema_version', '62');
  db.exec('PRAGMA user_version = 62');
}

function setLink(db: DatabaseSyncLike, id: string, link: string): void {
  db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(link, id);
}

interface Seeded {
  blank: string[];
  linked: string;
  unlinked: string;
}

/** One blank row per valid kind, one row with a link and one with none, all stamped with a fixed updated_at. */
function seed(root: string): Seeded {
  const blank = MEMORY_KINDS.map((kind) => createMemory(`a blank link on a ${kind} row`, { kind }));
  const linked = createMemory('a link to a successor', { kind: 'superseded' });
  const unlinked = createMemory('no link at all');
  writeEntriesTogether(root, [...blank, linked, unlinked]);
  withDb(root, (db) => {
    db.prepare('UPDATE memories SET updated_at = ?').run(FIXED_UPDATED_AT);
    for (const { id } of blank) setLink(db, id, '');
    setLink(db, linked.id, 'mem_successor');
  });
  return { blank: blank.map((entry) => entry.id), linked: linked.id, unlinked: unlinked.id };
}

describe('migration v63', () => {
  it('clears a blank link on a row of each valid kind and leaves a link and a NULL as stored', () => {
    const root = makeRoot('migration-v63-clears');
    const { blank, linked, unlinked } = seed(root);
    withDb(root, toV62);

    initStore(root);

    withDb(root, (db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(links(db)).toEqual({
        ...Object.fromEntries(blank.map((id) => [id, null])),
        [linked]: 'mem_successor',
        [unlinked]: null,
      });
    });
  });

  it('leaves a blank link on a row with no kind or an unknown kind, and the store still opens', () => {
    const root = makeRoot('migration-v63-kind');
    const noKind = createMemory('a blank link and no kind');
    const oddKind = createMemory('a blank link and an unknown kind');
    writeEntriesTogether(root, [noKind, oddKind]);
    const before = withDb(root, (db) => {
      // SAFETY: the SELECT names one TEXT column, sql.
      const guards = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)`)
        .all(...KIND_TRIGGERS) as Array<{ sql: string }>;
      expect(guards).toHaveLength(KIND_TRIGGERS.length);
      for (const name of KIND_TRIGGERS) db.exec(`DROP TRIGGER ${name}`);
      db.prepare(`UPDATE memories SET kind = NULL, superseded_by = '' WHERE id = ?`).run(noKind.id);
      db.prepare(`UPDATE memories SET kind = 'unknown', superseded_by = '' WHERE id = ?`).run(oddKind.id);
      for (const { sql } of guards) db.exec(sql);
      toV62(db);
      // The guard is back, so a clear that skipped the kind filter would abort the migration here.
      expect(() => db.exec(`UPDATE memories SET superseded_by = NULL WHERE superseded_by = ''`)).toThrow(
        /invalid kind/,
      );
      return triggerNames(db);
    });

    initStore(root);

    withDb(root, (db) => {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(links(db)).toEqual({ [noKind.id]: '', [oddKind.id]: '' });
      expect(triggerNames(db)).toEqual(before);
    });
  });

  it('changes no row the second time it runs, and the first time only the link of a cleared row', () => {
    const root = makeRoot('migration-v63-twice');
    const { blank } = seed(root);
    withDb(root, (db) => {
      const rows = rowsWithoutLink(db);
      const linksBefore = links(db);

      v63.up(db);
      const linksOnce = links(db);
      v63.up(db);

      expect(rowsWithoutLink(db)).toEqual(rows);
      expect(links(db)).toEqual(linksOnce);
      expect(linksOnce).toEqual({ ...linksBefore, ...Object.fromEntries(blank.map((id) => [id, null])) });
      expect(Object.values(linksBefore).filter((link) => link === '')).toHaveLength(blank.length);
    });
  });

  it('leaves a link of only whitespace as stored', () => {
    const root = makeRoot('migration-v63-spaces');
    const spaced = createMemory('a link of two spaces');
    const blank = createMemory('a blank link beside it');
    writeEntriesTogether(root, [spaced, blank]);
    withDb(root, (db) => {
      setLink(db, spaced.id, '  ');
      setLink(db, blank.id, '');
      toV62(db);
    });

    initStore(root);

    withDb(root, (db) => {
      expect(links(db)).toEqual({ [spaced.id]: '  ', [blank.id]: null });
    });
  });
});
