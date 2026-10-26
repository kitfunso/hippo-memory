// Schema v64 adds the trigram index substring search reads, the duplicate key the duplicate read groups on, and the
// audit and conflict indexes the bounded reads use.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { v64 } from '../../src/db/migrations/v64.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

const V64_INDEXES = [
  'idx_memories_duplicate_key',
  'idx_audit_log_tenant_op_ts',
  'idx_memory_conflicts_updated',
  'idx_memories_text_outside_trigrams',
];
const TRIGRAM_OBJECTS = [
  'memories_trigram_insert',
  'memories_trigram_delete',
  'memories_trigram_update',
  'memories_trigram',
];

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Takes a current store back to v63's shape: no trigram index, no duplicate key, none of v64's indexes. */
function toV63(db: DatabaseSyncLike): void {
  for (const name of V64_INDEXES) db.exec(`DROP INDEX ${name}`);
  for (const name of TRIGRAM_OBJECTS.slice(0, 3)) db.exec(`DROP TRIGGER ${name}`);
  db.exec('DROP TABLE memories_trigram');
  db.exec('ALTER TABLE memories DROP COLUMN duplicate_key');
}

function matches(db: DatabaseSyncLike, phrase: string): string[] {
  // SAFETY: the SELECT names one TEXT column, content.
  const rows = db
    .prepare(
      `SELECT m.content FROM memories_trigram t JOIN memories m ON m.rowid = t.rowid ` +
        `WHERE memories_trigram MATCH ? ORDER BY m.content`,
    )
    .all(`"${phrase}"`) as Array<{ content: string }>;
  return rows.map((row) => row.content);
}

describe('migration v64', () => {
  it('backfills the trigram index from the rows a v63 store holds and keeps it in step after', () => {
    const root = makeRoot('migration-v64');
    writeEntriesTogether(root, [
      createMemory('the quillwort ledger moved'),
      createMemory('a  quillwort\tledger moved'),
      createMemory('nothing alike'),
    ]);
    withDb(root, (db) => {
      toV63(db);
      v64.up(db);
      v64.up(db);
      expect(matches(db, 'wort')).toEqual(['a  quillwort\tledger moved', 'the quillwort ledger moved']);
      // SAFETY: the SELECT names one TEXT column, name.
      const names = (db.prepare(`SELECT name FROM sqlite_master`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining([...V64_INDEXES, ...TRIGRAM_OBJECTS]));

      db.exec(`UPDATE memories SET content = 'nothing alike, now a quillwort' WHERE content = 'nothing alike'`);
      db.exec(`DELETE FROM memories WHERE content = 'the quillwort ledger moved'`);
      expect(matches(db, 'wort')).toEqual(['a  quillwort\tledger moved', 'nothing alike, now a quillwort']);
    });
  });

  it('gives current distilled rows a whitespace-free duplicate key, and every other row none', () => {
    const root = makeRoot('migration-v64-key');
    writeEntriesTogether(root, [createMemory('a  b\tc'), createMemory('raw row', { kind: 'raw' })]);
    withDb(root, (db) => {
      // SAFETY: the SELECT names two TEXT columns.
      const rows = db.prepare(`SELECT content, duplicate_key FROM memories ORDER BY content`).all() as Array<{
        content: string;
        duplicate_key: string | null;
      }>;
      expect(rows).toEqual([
        { content: 'a  b\tc', duplicate_key: 'abc' },
        { content: 'raw row', duplicate_key: null },
      ]);
    });
  });
});
