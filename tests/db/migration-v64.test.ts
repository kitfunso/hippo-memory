// Schema v64 adds the trigram index substring search reads, the duplicate hash the duplicate read groups on, and the
// audit and conflict indexes the bounded reads use.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { v64 } from '../../src/db/migrations/v64.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { listDuplicateCandidates } from '../../src/store/sqlite/sleep-scans.js';

function plan(db: DatabaseSyncLike, sql: string): string {
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

const V64_INDEXES = [
  'idx_memories_duplicate_hash',
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

/** Takes a current store back to v63's shape: no trigram index, no duplicate hash and none of v64's indexes. */
function toV63(db: DatabaseSyncLike): void {
  for (const name of V64_INDEXES) db.exec(`DROP INDEX ${name}`);
  db.exec('DROP TRIGGER memories_duplicate_hash_stale');
  db.exec('ALTER TABLE memories DROP COLUMN duplicate_hash');
  for (const name of TRIGRAM_OBJECTS.slice(0, 3)) db.exec(`DROP TRIGGER ${name}`);
  db.exec('DROP TABLE memories_trigram');
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

  it('groups duplicates by their spaceless text through the duplicate hash index', () => {
    const root = makeRoot('migration-v64-key');
    writeEntriesTogether(root, [
      createMemory('a  b\tc'),
      createMemory('ab c'),
      createMemory('abc', { kind: 'raw' }),
      createMemory('other'),
    ]);
    withDb(root, (db) => {
      const { result, statements } = recordStatements(() => listDuplicateCandidates(db));
      expect(result.rows.map((row) => row.content).sort()).toEqual(['a  b\tc', 'ab c']);
      const keyRead = statements.find((sql) => sql.includes('HAVING COUNT(*) > 1'));
      expect(plan(db, keyRead!)).toMatch(/USING (COVERING )?INDEX idx_memories_duplicate_hash/);
    });
  });

  it('hashes the rows v63 held, and finds a row an older binary wrote or edited without its hash', () => {
    const root = makeRoot('migration-v64-old-writes');
    writeEntriesTogether(root, [createMemory('a  b c'), createMemory('kept apart'), createMemory('x y')]);
    withDb(root, (db) => {
      toV63(db);
      v64.up(db);
      // SAFETY: the SELECT names one INTEGER column, n.
      const unhashed = () =>
        (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE duplicate_hash IS NULL').get() as { n: number }).n;
      expect(unhashed()).toBe(0);

      db.exec(`UPDATE memories SET content = 'ab c' WHERE content = 'kept apart'`);
      // An older binary's insert leaves the column it does not know empty.
      db.exec(`CREATE TEMP TABLE copied AS SELECT * FROM memories WHERE content = 'x y'`);
      db.exec(`UPDATE copied SET id = 'old_binary', content = 'x' || char(9) || 'y', duplicate_hash = NULL`);
      db.exec(`INSERT INTO memories SELECT * FROM copied`);
      expect(unhashed()).toBe(2);
      const contents = listDuplicateCandidates(db).rows.map((row) => row.content);
      expect(contents.sort()).toEqual(['a  b c', 'ab c', 'x\ty', 'x y']);
    });
  });
});
