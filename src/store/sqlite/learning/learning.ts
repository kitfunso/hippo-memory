import { confirmedOutcomeTimes } from '../audit/audit.js';
import { listEntriesMentioning, readEntry } from '../entries/entry-reads.js';
import { addTagToEntries } from '../entries/entry-writes.js';
import type { Learning } from '../../../base/ports/store/learning.js';
import type { Handles } from '../runtime/open.js';
import { openStore } from '../runtime/handles.js';
import { bound, type Bodies } from '../runtime/bound.js';

const learningReadsBodies: Bodies<Pick<Learning, 'entriesMentioning' | 'readEntry'>> = {
  entriesMentioning: listEntriesMentioning,
  readEntry: readEntry,
};

/** The learn passes' store work on its hippo.db, each call on its own short-lived handle. */
export function sqliteLearning({ on, files }: Handles): Learning {
  return {
    ...bound(on, learningReadsBodies, openStore),
    ...bound<Pick<Learning, 'addTagToEntries'>>(
      on,
      { addTagToEntries: (db, ...args) => addTagToEntries(db, files, ...args) },
      openStore,
    ),
    ...bound<Pick<Learning, 'confirmedOutcomeTimes'>>(on, { confirmedOutcomeTimes: confirmedOutcomeTimes }),
  };
}
