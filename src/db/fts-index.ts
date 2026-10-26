import type { DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';

export const MEMORIES_FTS_DDL =
  'CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tags)';

// The part-word index reads its text from memories itself, so it keeps no second copy; triggers, not hippo's writers,
// keep it level, so an older binary's writes and a raw SQL edit land in it too.
const MEMORIES_TRIGRAM_DDL =
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_trigram USING fts5(content, tags_json, content='memories', ` +
  `tokenize='trigram')`;
const TRIGRAM_DELETE =
  `INSERT INTO memories_trigram(memories_trigram, rowid, content, tags_json) ` +
  `VALUES ('delete', old.rowid, old.content, old.tags_json);`;
const TRIGRAM_INSERT = `INSERT INTO memories_trigram(rowid, content, tags_json) \
VALUES (new.rowid, new.content, new.tags_json);`;
const MEMORIES_TRIGRAM_TRIGGER_DDL = [
  `CREATE TRIGGER IF NOT EXISTS memories_trigram_insert AFTER INSERT ON memories BEGIN ${TRIGRAM_INSERT} END`,
  `CREATE TRIGGER IF NOT EXISTS memories_trigram_delete AFTER DELETE ON memories BEGIN ${TRIGRAM_DELETE} END`,
  // Most updates rewrite every column with its own value; the WHEN keeps those from re-indexing the text.
  `CREATE TRIGGER IF NOT EXISTS memories_trigram_update AFTER UPDATE OF content, tags_json ON memories ` +
    `WHEN old.content IS NOT new.content OR old.tags_json IS NOT new.tags_json BEGIN ${TRIGRAM_DELETE} ` +
    `${TRIGRAM_INSERT} END`,
] as const;

/** Every full-text table and trigger an open re-asserts, for the required-object list. */
export const FTS_INDEX_DDL = [MEMORIES_FTS_DDL, MEMORIES_TRIGRAM_DDL, ...MEMORIES_TRIGRAM_TRIGGER_DDL] as const;

/** The substring index over memories' content and tags, its triggers, and its rows when this call made the table. */
export function ensureTrigramIndex(db: DatabaseSyncLike): void {
  const made = !tableExists(db, 'memories_trigram');
  db.exec(MEMORIES_TRIGRAM_DDL);
  for (const ddl of MEMORIES_TRIGRAM_TRIGGER_DDL) db.exec(ddl);
  // After the triggers, so a write that lands between the two is in the rebuild or in a trigger.
  if (made) rebuildTrigramIndex(db);
}

/** Re-reads every memory into the substring index. */
export function rebuildTrigramIndex(db: DatabaseSyncLike): void {
  db.exec(`INSERT INTO memories_trigram(memories_trigram) VALUES ('rebuild')`);
}

/** Whether an error's `message` says this SQLite lacks FTS5 or the trigram tokenizer: the one failure that turns
 * full-text search off. */
export function isFtsMissing(message: string): boolean {
  return (/no such module/i.test(message) && /fts5/i.test(message)) || /no such tokenizer/i.test(message);
}
