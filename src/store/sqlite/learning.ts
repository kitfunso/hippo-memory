import { confirmedOutcomeTimesAt } from './audit.js';
import { loadCurrentEntriesFromOriginsAt, loadEntriesMentioningAt, readEntryAt } from './entry-reads.js';
import { addTagToEntriesAt, writeEntriesTogetherAt, writeEntryAt } from './entry-writes.js';
import type { Learning } from '../port/learning.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';

/** The learn passes' store work on its hippo.db, each call on its own short-lived handle. */
export function sqliteLearning(on: OnHandle): Learning {
  return {
    entriesMentioning: (tokens, tag, tenantId, page) =>
      on((db) => loadEntriesMentioningAt(db, tokens, tag, tenantId, page), openStore),
    readEntry: (id, tenantId) => on((db) => readEntryAt(db, id, tenantId), openStore),
    currentEntriesFromOrigins: (tenantId, origins) =>
      on((db) => loadCurrentEntriesFromOriginsAt(db, tenantId, origins), openStore),
    writeEntry: (entry) => on((db, files) => writeEntryAt(db, files, entry), openStore),
    writeEntriesTogether: (entries) =>
      entries.length === 0 ? 0 : on((db, files) => writeEntriesTogetherAt(db, files, entries), openStore),
    addTagToEntries: (tenantId, ids, tag) =>
      on((db, files) => addTagToEntriesAt(db, files, tenantId, ids, tag), openStore),
    confirmedOutcomeTimes: (tenantId, since) => on((db) => confirmedOutcomeTimesAt(db, tenantId, since)),
  };
}
