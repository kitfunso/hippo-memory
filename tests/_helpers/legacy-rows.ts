// Writes store secret text redacted, so a test of a veto over secret rows plants them as a release before the boundary left them.
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';

/** Puts each row's raw text back in memories and its full-text row, on `db`. */
export function restoreRawText(db: DatabaseSyncLike, entries: readonly Pick<MemoryEntry, 'id' | 'content'>[]): void {
  for (const { id, content } of entries) {
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id);
    db.prepare('UPDATE memories_fts SET content = ? WHERE id = ?').run(content, id);
  }
}

/** restoreRawText on the hippo.db under `root`. */
export function restoreRawTextAt(root: string, entries: readonly Pick<MemoryEntry, 'id' | 'content'>[]): void {
  const db = openHippoDb(root);
  try {
    restoreRawText(db, entries);
  } finally {
    closeHippoDb(db);
  }
}
