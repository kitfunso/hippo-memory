// The built-in store's sharing reads and writes: the existing functions, bound to this hippo root.
import { tallySources } from '../candidates.js';
import { loadEntriesByIds, loadEntriesWithSignals, loadEntryTextKeys } from '../entry-reads.js';
import { writeEntriesSkippingRejected } from '../entry-writes.js';
import { initStore } from '../open.js';
import type { Sharing } from '../port/sharing.js';
import { loadRecallEntries, loadSearchEntries } from '../search-rows.js';

export function sqliteSharing(hippoRoot: string): Sharing {
  return {
    ensureFiles: () => initStore(hippoRoot),
    entriesWithSignals: (signals, tenantId) => loadEntriesWithSignals(hippoRoot, signals, tenantId),
    textKeys: () => loadEntryTextKeys(hippoRoot),
    entriesByIds: (ids) => loadEntriesByIds(hippoRoot, ids),
    writeSkippingRejected: (fill) => writeEntriesSkippingRejected(hippoRoot, fill),
    sourceTallies: (tenantId) => tallySources(hippoRoot, tenantId),
    searchEntries: (query, limit, tenantId) => loadSearchEntries(hippoRoot, query, limit, tenantId),
    recallEntries: (query, options) => loadRecallEntries(hippoRoot, query, options),
  };
}
