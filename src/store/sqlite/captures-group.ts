// hippo.db's Captures: the whole batch on one handle, opened with openStore since a write sets up the mirror folders.
import { writeCapturedItemsAt } from '../capture-write.js';
import { EVERY_SCOPE, loadTextsHoldingWordsAt } from '../candidates.js';
import { type OnHandle, openStore } from '../open.js';
import type { Captures } from '../port/captures.js';

export function sqliteCaptures(on: OnHandle): Captures {
  return {
    write: (items, keys, opts) => on((db, files) => writeCapturedItemsAt(db, files, items, keys, opts), openStore),
    textsHolding: (tenantId, words, { project, everyScope } = {}) =>
      on(
        (db) => loadTextsHoldingWordsAt(db, tenantId, words, project, everyScope ? EVERY_SCOPE : undefined),
        openStore,
      ),
  };
}
