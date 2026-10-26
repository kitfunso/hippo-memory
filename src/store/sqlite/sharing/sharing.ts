// The built-in store's sharing reads: the existing functions, bound to this store.
import { tallySources } from '../recall/candidates.js';
import { listEntriesWithSignals, listEntryTextKeysPage, readTakenIds } from '../entries/entry-reads.js';
import { listTextKeysHolding } from './copy-rows.js';
import type { OnHandle } from '../runtime/open.js';
import { openStore } from '../runtime/handles.js';
import { bound, type Bodies } from '../runtime/bound.js';
import type { Sharing } from '../../../base/ports/store/sharing.js';
import { listRecallEntries, listSearchEntries } from '../recall/search-rows.js';

const sharingReadsBodies: Bodies<Sharing> = {
  entriesWithSignals: listEntriesWithSignals,
  textKeysPage: listEntryTextKeysPage,
  textKeysHolding: listTextKeysHolding,
  takenIds: readTakenIds,
  sourceTallies: tallySources,
  searchEntries: listSearchEntries,
  recallEntries: listRecallEntries,
};

export function sqliteSharing(on: OnHandle): Sharing {
  return bound(on, sharingReadsBodies, openStore);
}
