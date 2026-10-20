import { confirmedOutcomeTimesAt } from './audit.js';
import { loadCurrentEntriesFromOriginsAt, loadEntriesMentioningAt, readEntryAt } from './entry-reads.js';
import { addTagToEntriesAt } from './entry-writes.js';
import type { Learning } from '../port/learning.js';
import type { OnHandle } from './open.js';
import type { Sync } from './served.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, type Bodies } from './bound.js';

const learningReadsAt: Bodies<Pick<Learning, 'entriesMentioning' | 'readEntry' | 'currentEntriesFromOrigins'>> = {
  entriesMentioning: loadEntriesMentioningAt,
  readEntry: readEntryAt,
  currentEntriesFromOrigins: loadCurrentEntriesFromOriginsAt,
};

/** The learn passes' store work on its hippo.db, each call on its own short-lived handle. */
export function sqliteLearning(on: OnHandle): Sync<Learning> {
  return {
    ...bound(on, learningReadsAt, openStore),
    ...boundWithFiles<Pick<Learning, 'addTagToEntries'>>(on, { addTagToEntries: addTagToEntriesAt }, openStore),
    ...bound<Pick<Learning, 'confirmedOutcomeTimes'>>(on, { confirmedOutcomeTimes: confirmedOutcomeTimesAt }),
  };
}
