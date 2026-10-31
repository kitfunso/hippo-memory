import { confirmedOutcomeTimes } from '../audit/audit.js';
import { listEntriesMentioning } from '../entries/entry-mentions.js';
import { readEntry } from '../entries/entry-reads.js';
import { addTagToEntries } from '../entries/entry-writes.js';
import type { Learning } from '../../../base/records/learning.js';
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
    ...bound(
      on,
      { addTagToEntries: (db, ...args) => addTagToEntries(db, files, ...args) } satisfies Bodies<
        Pick<Learning, 'addTagToEntries'>
      >,
      openStore,
    ),
    ...bound(on, {
      confirmedOutcomeTimes: confirmedOutcomeTimes,
    } satisfies Bodies<Pick<Learning, 'confirmedOutcomeTimes'>>),
  };
}
