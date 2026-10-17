// hippo.db's Captures: the whole batch on one handle, opened with openStore since a write sets up the mirror folders.
import { writeCapturedItemsAt } from '../capture-write.js';
import { onHandle, openStore } from '../open.js';
import type { Captures } from '../port/captures.js';

export function sqliteCaptures(hippoRoot: string): Captures {
  return {
    write: (items, keys, opts) =>
      onHandle(hippoRoot, (db) => writeCapturedItemsAt(db, hippoRoot, items, keys, opts), openStore),
  };
}
