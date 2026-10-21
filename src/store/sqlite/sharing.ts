// The built-in store's sharing reads: the existing functions, bound to this store.
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { loadTextsHoldingWords, tallySources } from './candidates.js';
import { EVERY_SCOPE } from './rule-sql.js';
import {
  loadEntriesByIds,
  loadEntriesPage,
  loadEntriesWithSignals,
  loadEntryTextKeysPage,
  selectTakenIds,
  selectTextKeysHolding,
} from './entry-reads.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import type { Sync } from './served.js';
import type { Sharing } from '../port/sharing.js';
import { loadRecallEntries, loadSearchEntries } from './search-rows.js';

const sharingReadsBodies: Bodies<Sharing> = {
  entriesPage: loadEntriesPage,
  entriesWithSignals: loadEntriesWithSignals,
  textKeysPage: loadEntryTextKeysPage,
  textKeysHolding: selectTextKeysHolding,
  textsHolding: (db, tenantId, words, { project, everyScope }) =>
    loadTextsHoldingWords(db, tenantId, words, project, everyScope === true ? EVERY_SCOPE : undefined),
  takenIds: selectTakenIds,
  entriesByIds: (db, ids) => loadEntriesByIds(db, ids, ALL_TENANTS),
  sourceTallies: tallySources,
  searchEntries: loadSearchEntries,
  recallEntries: loadRecallEntries,
};

export function sqliteSharing(on: OnHandle): Sync<Sharing> {
  return bound(on, sharingReadsBodies, openStore);
}

export function sqliteImportKeys(on: OnHandle): Sync<Pick<Sharing, 'textKeysHolding'>> {
  return bound<Pick<Sharing, 'textKeysHolding'>>(on, { textKeysHolding: selectTextKeysHolding }, openStore);
}
