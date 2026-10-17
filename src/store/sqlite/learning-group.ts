import { confirmedOutcomeTimesAt } from '../audit.js';
import {
  loadAllEntriesAt,
  loadCurrentEntriesFromOriginsAt,
  loadEntriesMentioningAt,
  loadEveryTenantEntriesAt,
  readEntryAt,
} from '../entry-reads.js';
import { addTagToEntriesAt, writeEntriesTogetherAt, writeEntryAt } from '../entry-writes.js';
import type { Learning } from '../port/learning.js';
import { type OnHandle, openStore } from '../open.js';

/** The learn passes' store work on its hippo.db, each call on its own short-lived handle. */
export function sqliteLearning(on: OnHandle): Learning {
  return {
    allEntries: (tenantId) =>
      tenantId === undefined
        ? on((db) => loadEveryTenantEntriesAt(db), openStore)
        : on((db) => loadAllEntriesAt(db, tenantId), openStore),
    entriesMentioning: (tokens, tag, tenantId) =>
      on((db) => loadEntriesMentioningAt(db, tokens, tag, tenantId), openStore),
    readEntry: (id, tenantId) => on((db) => readEntryAt(db, id, tenantId), openStore),
    currentEntriesFromOrigins: (tenantId, origins) =>
      on((db) => loadCurrentEntriesFromOriginsAt(db, tenantId, origins), openStore),
    writeEntry: (entry) => on((db, files) => writeEntryAt(db, files, entry), openStore),
    writeEntriesTogether: (entries) =>
      entries.length === 0 ? 0 : on((db, files) => writeEntriesTogetherAt(db, files, entries), openStore),
    addTagToEntries: (tenantId, ids, tag) =>
      on((db, files) => addTagToEntriesAt(db, files, tenantId, ids, tag), openStore),
    confirmedOutcomeTimes: (tenantId) => on((db) => confirmedOutcomeTimesAt(db, tenantId)),
  };
}
