// The built-in store's sharing reads: the existing functions, bound to this store.
import { tallySources } from './candidates.js';
import { loadEntriesWithSignals, loadEntryTextKeysPage, selectTakenIds, selectTextKeysHolding } from './entry-reads.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import type { Sync } from './served.js';
import type { Sharing } from '../port/sharing.js';
import { loadRecallEntries, loadSearchEntries } from './search-rows.js';

const sharingReadsBodies: Bodies<Sharing> = {
  entriesWithSignals: loadEntriesWithSignals,
  textKeysPage: loadEntryTextKeysPage,
  textKeysHolding: selectTextKeysHolding,
  takenIds: selectTakenIds,
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
