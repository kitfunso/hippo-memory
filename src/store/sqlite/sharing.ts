// The built-in store's sharing reads and writes: the existing functions, bound to this store.
import { ALL_TENANTS } from '../../util/tenant.js';
import { tallySourcesAt } from './candidates.js';
import {
  loadEntriesByIdsAt,
  loadEntriesPageAt,
  loadEntriesWithSignalsAt,
  loadEntryTextKeysPageAt,
  selectTakenIdsAt,
  selectTextKeysHoldingAt,
} from './entry-reads.js';
import { writeEntriesSkippingRejectedAt } from './entry-writes.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, type Bodies } from './bound.js';
import { served } from './served.js';
import type { Sharing } from '../local/sharing.js';
import { loadRecallEntriesAt, loadSearchEntriesAt } from './search-rows.js';

type SharingReads = Omit<Sharing, 'writeSkippingRejected' | 'sourceTallies'>;

const sharingReadsAt: Bodies<SharingReads> = {
  entriesPage: loadEntriesPageAt,
  entriesWithSignals: loadEntriesWithSignalsAt,
  textKeysPage: loadEntryTextKeysPageAt,
  textKeysHolding: selectTextKeysHoldingAt,
  takenIds: selectTakenIdsAt,
  entriesByIds: (db, ids) => loadEntriesByIdsAt(db, ids, ALL_TENANTS),
  searchEntries: loadSearchEntriesAt,
  recallEntries: loadRecallEntriesAt,
};

type Tallies = Pick<Sharing, 'sourceTallies'>;

export function sqliteSharing(on: OnHandle): Sharing {
  return {
    ...bound(on, sharingReadsAt, openStore),
    ...boundWithFiles<Pick<Sharing, 'writeSkippingRejected'>>(
      on,
      { writeSkippingRejected: writeEntriesSkippingRejectedAt },
      openStore,
    ),
    // hippo_peers awaits the tallies on a served store's worker, so this one method answers through a Promise.
    ...served<Tallies>(bound<Tallies>(on, { sourceTallies: tallySourcesAt }, openStore)),
  };
}
