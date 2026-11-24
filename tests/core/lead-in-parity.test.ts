import { describe, expect, it } from 'vitest';
import { embeddingInputText } from '../../src/base/embeddings/index-identity.js';
import { FINDABLE_TEXT_SQL, findableText } from '../../src/base/memory/lead-in.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { repairFtsDrift } from '../../src/db/migrate.js';
import { entryText } from '../../src/domain/search/bm25.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { batchWriteAndDeleteInFolder, loadSearchEntries, writeEntry } from '../_helpers/root-forms.js';

const CONTENT = 'Three times a week; it keeps us on track.';
const LEAD_IN = 'user: How often do Keith and Mel run the zephyrline';
const CASES = [
  ['no lead-in', undefined],
  ['a lead-in', LEAD_IN],
  ['an empty lead-in', ''],
] as const;

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function seed(leadIn: string | undefined) {
  const root = makeRoot('lead-in-parity');
  const entry = createMemory(CONTENT, { tags: ['ops', 'cache'], tenantId: 'default', leadIn: leadIn || undefined });
  writeEntry(root, entry);
  if (leadIn === '') withDb(root, (db) => db.prepare('UPDATE memories SET lead_in = ? WHERE id = ?').run('', entry.id));
  return { root, entry };
}

const ftsRow = (db: DatabaseSyncLike, id: string): { content: string; tags: string } =>
  // SAFETY: the SELECT names the two FTS columns of the row.
  db.prepare('SELECT content, tags FROM memories_fts WHERE id = ?').get(id) as { content: string; tags: string };

const ftsHits = (db: DatabaseSyncLike, word: string): string[] =>
  // SAFETY: the SELECT names the one UNINDEXED id column.
  (db.prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ?').all(word) as Array<{ id: string }>).map(
    (r) => r.id,
  );

const words = (text: string): string[] => text.toLowerCase().split(/\s+/).filter(Boolean).sort();

describe('the findable text, by copy', () => {
  it.each(CASES)(
    'the FTS text from syncFtsRow equals FINDABLE_TEXT_SQL after a forced drift repair: %s',
    (_name, leadIn) => {
      const { root, entry } = seed(leadIn);
      withDb(root, (db) => {
        const written = ftsRow(db, entry.id).content;
        // SAFETY: the SELECT names one computed TEXT column.
        const sql = db
          .prepare(`SELECT ${FINDABLE_TEXT_SQL('m')} AS t FROM memories m WHERE m.id = ?`)
          .get(entry.id) as {
          t: string;
        };
        expect(written).toBe(findableText({ content: CONTENT, leadIn }));
        expect(sql.t).toBe(written);

        db.prepare('DELETE FROM memories_fts WHERE id = ?').run(entry.id);
        expect(repairFtsDrift(db)).toBe(true);
        expect(ftsRow(db, entry.id).content).toBe(written);
      });
    },
  );

  it.each(CASES)('a batch write indexes the same text as a single write: %s', (_name, leadIn) => {
    const root = makeRoot('lead-in-parity-batch');
    const entry = createMemory(CONTENT, { tags: ['ops', 'cache'], tenantId: 'default', leadIn: leadIn || undefined });
    batchWriteAndDeleteInFolder(root, [entry], []);
    expect(withDb(root, (db) => ftsRow(db, entry.id).content)).toBe(findableText({ content: CONTENT, leadIn }));
  });

  it.each(CASES)(
    'a repaired row is still found by a content word, and by a lead-in word only if it has one: %s',
    (_name, leadIn) => {
      const { root, entry } = seed(leadIn);
      withDb(root, (db) => {
        db.prepare('DELETE FROM memories_fts WHERE id = ?').run(entry.id);
        expect(repairFtsDrift(db)).toBe(true);
        expect(ftsHits(db, 'track')).toEqual([entry.id]);
        expect(ftsHits(db, 'zephyrline')).toEqual(leadIn ? [entry.id] : []);
      });
      expect(loadSearchEntries(root, 'track', 10, 'default').map((e) => e.id)).toEqual([entry.id]);
    },
  );

  it.each(CASES)(
    'the write-time embed text equals the rebuild-time embed text read through entriesByIds: %s',
    async (_name, leadIn) => {
      const { root, entry } = seed(leadIn);
      const [read] = await sqliteStore(root).entriesByIds([entry.id], 'default');
      expect(embeddingInputText(read!)).toBe(embeddingInputText(entry));
      expect(embeddingInputText(entry)).toBe(`${findableText({ content: CONTENT, leadIn })} ops cache`);
    },
  );

  it.each(CASES)(
    'the BM25 document, the FTS text and the embed text hold the same words: %s',
    async (_name, leadIn) => {
      const { root, entry } = seed(leadIn);
      const [read] = await sqliteStore(root).entriesByIds([entry.id], 'default');
      const fts = withDb(root, (db) => ftsRow(db, entry.id));
      const forFts = words(`${fts.content} ${fts.tags}`);
      expect(words(entryText(read!))).toEqual(forFts);
      expect(words(embeddingInputText(read!))).toEqual(forFts);
      expect(forFts.includes('zephyrline')).toBe(Boolean(leadIn));
    },
  );
});
