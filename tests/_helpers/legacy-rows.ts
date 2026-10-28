// Writes store secret text redacted, so a test of a veto over secret rows plants them as a release before the boundary left them.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { upsertEntryRow } from '../../src/store/sqlite/entry-row.js';
import { createMemory } from './default-half-life-memory.js';

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

/** A new row as a release before the boundary wrote it: raw text in memories, its full-text row and its mirror. */
export function plantLegacyRow(root: string, content: string): MemoryEntry {
  const entry = createMemory(content);
  const db = openHippoDb(root);
  try {
    upsertEntryRow(db, entry);
    restoreRawText(db, [entry]);
  } finally {
    closeHippoDb(db);
  }
  const file = path.join(root, entry.layer, `${entry.id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---
id: ${entry.id}
---

${content}
`,
  );
  return entry;
}
