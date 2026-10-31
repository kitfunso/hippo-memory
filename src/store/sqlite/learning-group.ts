import { confirmedOutcomeTimes } from '../audit.js';
import { loadAllEntries, loadCurrentEntriesFromOrigins, loadEntriesMentioning, readEntry } from '../entry-reads.js';
import { addTagToEntries, writeEntriesTogether, writeEntry } from '../entry-writes.js';
import type { Learning } from '../port/learning.js';

/** The learn passes' store work on the hippo.db under `hippoRoot`, each call on its own short-lived handle. */
export function sqliteLearning(hippoRoot: string): Learning {
  return {
    allEntries: (tenantId) => loadAllEntries(hippoRoot, tenantId),
    entriesMentioning: (tokens, tag, tenantId) => loadEntriesMentioning(hippoRoot, tokens, tag, tenantId),
    readEntry: (id, tenantId) => readEntry(hippoRoot, id, tenantId),
    currentEntriesFromOrigins: (tenantId, origins) => loadCurrentEntriesFromOrigins(hippoRoot, tenantId, origins),
    writeEntry: (entry) => writeEntry(hippoRoot, entry),
    writeEntriesTogether: (entries) => writeEntriesTogether(hippoRoot, entries),
    addTagToEntries: (tenantId, ids, tag) => addTagToEntries(hippoRoot, tenantId, ids, tag),
    confirmedOutcomeTimes: (tenantId) => confirmedOutcomeTimes(hippoRoot, tenantId),
  };
}
