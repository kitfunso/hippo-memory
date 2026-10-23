// The built-in store's sharing reads: the existing functions, bound to this store.
import { tallySources } from './candidates.js';
import { loadEntriesWithSignals, loadEntryTextKeysPage, selectTakenIds } from './entry-reads.js';
import { selectTextKeysHolding } from './copy-rows.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
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

export function sqliteSharing(on: OnHandle): Sharing {
  return bound(on, sharingReadsBodies, openStore);
}
