// The built-in store's sharing reads and writes: the existing functions, bound to this store.
import { tallySourcesAt } from '../candidates.js';
import {
  loadEntriesByIdsAt,
  loadEntriesPageAt,
  loadEntriesWithSignalsAt,
  loadEntryTextKeysPageAt,
} from '../entry-reads.js';
import { writeEntriesSkippingRejectedAt } from '../entry-writes.js';
import type { OnHandle } from '../open.js';
import { openStore } from './handles.js';
import type { Sharing } from '../port/sharing.js';
import { loadRecallEntriesAt, loadSearchEntriesAt } from '../search-rows.js';

export function sqliteSharing(on: OnHandle): Sharing {
  return {
    entriesPage: (tenantId, page) => on((db) => loadEntriesPageAt(db, tenantId, page), openStore),
    entriesWithSignals: (signals, tenantId, page) =>
      on((db) => loadEntriesWithSignalsAt(db, signals, tenantId, page), openStore),
    textKeysPage: (tenantId, page) => on((db) => loadEntryTextKeysPageAt(db, tenantId, page), openStore),
    entriesByIds: (ids) => on((db) => loadEntriesByIdsAt(db, ids), openStore),
    writeSkippingRejected: (fill) => on((db, files) => writeEntriesSkippingRejectedAt(db, files, fill), openStore),
    sourceTallies: async (tenantId) => on((db) => tallySourcesAt(db, tenantId), openStore),
    searchEntries: (query, limit, tenantId) => on((db) => loadSearchEntriesAt(db, query, limit, tenantId), openStore),
    recallEntries: (query, options) => on((db) => loadRecallEntriesAt(db, query, options), openStore),
  };
}
