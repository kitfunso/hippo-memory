import { confirmedOutcomeTimesAt } from './audit.js';
import { loadCurrentEntriesFromOriginsAt, loadEntriesMentioningAt, readEntryAt } from './entry-reads.js';
import { addTagToEntriesAt, writeEntriesTogetherAt, writeEntryAt } from './entry-writes.js';
import type { Learning } from '../port/learning.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, skipEmpty, type Bodies, type FileBodies } from './bound.js';

const learningReadsAt: Bodies<Pick<Learning, 'entriesMentioning' | 'readEntry' | 'currentEntriesFromOrigins'>> = {
  entriesMentioning: loadEntriesMentioningAt,
  readEntry: readEntryAt,
  currentEntriesFromOrigins: loadCurrentEntriesFromOriginsAt,
};

const learningWritesAt: FileBodies<Pick<Learning, 'writeEntry' | 'writeEntriesTogether' | 'addTagToEntries'>> = {
  writeEntry: writeEntryAt,
  writeEntriesTogether: writeEntriesTogetherAt,
  addTagToEntries: addTagToEntriesAt,
};

/** The learn passes' store work on its hippo.db, each call on its own short-lived handle. */
export function sqliteLearning(on: OnHandle): Learning {
  const writes = boundWithFiles(on, learningWritesAt, openStore);
  return {
    ...bound(on, learningReadsAt, openStore),
    ...writes,
    writeEntriesTogether: skipEmpty(writes.writeEntriesTogether, () => 0),
    ...bound<Pick<Learning, 'confirmedOutcomeTimes'>>(on, { confirmedOutcomeTimes: confirmedOutcomeTimesAt }),
  };
}
