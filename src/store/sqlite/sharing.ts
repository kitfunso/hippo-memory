// The built-in store's sharing reads: the existing functions, bound to this store.
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { EVERY_SCOPE, loadTextsHoldingWordsAt, tallySourcesAt } from './candidates.js';
import {
  loadEntriesByIdsAt,
  loadEntriesPageAt,
  loadEntriesWithSignalsAt,
  loadEntryTextKeysPageAt,
  selectTakenIdsAt,
  selectTextKeysHoldingAt,
} from './entry-reads.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import type { Sync } from './served.js';
import type { Sharing } from '../port/sharing.js';
import { loadRecallEntriesAt, loadSearchEntriesAt } from './search-rows.js';

const sharingReadsAt: Bodies<Sharing> = {
  entriesPage: loadEntriesPageAt,
  entriesWithSignals: loadEntriesWithSignalsAt,
  textKeysPage: loadEntryTextKeysPageAt,
  textKeysHolding: selectTextKeysHoldingAt,
  textsHolding: (db, tenantId, words, { project, everyScope }) =>
    loadTextsHoldingWordsAt(db, tenantId, words, project, everyScope === true ? EVERY_SCOPE : undefined),
  takenIds: selectTakenIdsAt,
  entriesByIds: (db, ids) => loadEntriesByIdsAt(db, ids, ALL_TENANTS),
  sourceTallies: tallySourcesAt,
  searchEntries: loadSearchEntriesAt,
  recallEntries: loadRecallEntriesAt,
};

export function sqliteSharing(on: OnHandle): Sync<Sharing> {
  return bound(on, sharingReadsAt, openStore);
}

export function sqliteImportKeys(on: OnHandle): Sync<Pick<Sharing, 'textKeysHolding'>> {
  return bound<Pick<Sharing, 'textKeysHolding'>>(on, { textKeysHolding: selectTextKeysHoldingAt }, openStore);
}
