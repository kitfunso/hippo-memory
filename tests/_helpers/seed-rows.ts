import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { closeHippoDb, openHippoDb, withWriteScope } from '../../src/db/index.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { createMemory } from './default-half-life-memory.js';
import { writeEntriesTogether } from './root-forms.js';

/** `count` default-tenant rows whose text is `content(i)`, with `extra(i)` laid over each; not written anywhere. */
export function memoryRows(
  count: number,
  content: (i: number) => string,
  extra: (i: number) => Partial<MemoryEntry> = () => ({}),
): MemoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({ ...createMemory(content(i)), ...extra(i) }));
}

/** `memoryRows`, written to the store at `root` in one transaction. */
export function seedRows(
  root: string,
  count: number,
  content: (i: number) => string,
  extra?: (i: number) => Partial<MemoryEntry>,
): MemoryEntry[] {
  const rows = memoryRows(count, content, extra);
  writeEntriesTogether(root, rows);
  return rows;
}

/** `entries` on hippo.db alone, in one transaction, for a test that reads no markdown mirror: a mirror costs a file per row. */
export function writeRowsOnly(root: string, entries: readonly MemoryEntry[]): void {
  const db = openHippoDb(root);
  try {
    withWriteScope(db, 'seed_rows', () => {
      for (const entry of entries) writeEntryDbOnly(db, entry);
    });
  } finally {
    closeHippoDb(db);
  }
}
