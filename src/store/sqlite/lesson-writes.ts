// hippo.db's LessonWrites group: git learn's batch, with the word and tag reads it checks first.
import { loadTextsHoldingWords } from './candidates.js';
import { contentsWithTag } from './entry-reads.js';
import { writeEntriesSkippingRejected, writeEntriesTogether } from './entry-writes.js';
import { updateStats } from './index-and-stats.js';
import type { Handles, StoreFiles } from './open.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { bound, skipEmpty, type Bodies } from './bound.js';
import { openStore } from './handles.js';
import type { LessonWrites } from '../port.js';
import { touchableScopeSql } from './rule-sql.js';

/** `entries` in order, each one a rejection refuses left out; returns the ids written. */
function writeSkippingRejected(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entries: readonly MemoryEntry[],
  actor: string,
): string[] {
  const written: string[] = [];
  writeEntriesSkippingRejected(
    db,
    files,
    (put) => {
      for (const entry of entries) if (put(entry)) written.push(entry.id);
    },
    actor,
  );
  return written;
}

const lessonReadsBodies: Bodies<Pick<LessonWrites, 'textsHoldingWords' | 'contentsWithTag'>> = {
  textsHoldingWords: (db, tenantId, words, ownScope) =>
    loadTextsHoldingWords(db, tenantId, words, undefined, touchableScopeSql('', ownScope)),
  contentsWithTag: contentsWithTag,
};

function lessonWritesBodies(files: StoreFiles): Bodies<Omit<LessonWrites, 'textsHoldingWords' | 'contentsWithTag'>> {
  return {
    writeSkippingRejected: (db, ...args) => writeSkippingRejected(db, files, ...args),
    writeTogether: (db, entries) => {
      writeEntriesTogether(db, files, entries);
    },
    bumpRemembered: (db, count) => updateStats(db, files, { remembered: count }),
  };
}

export function sqliteLessonWrites({ on, files }: Handles): LessonWrites {
  const writes = bound(on, lessonWritesBodies(files), openStore);
  return {
    ...bound(on, lessonReadsBodies, openStore),
    ...writes,
    writeTogether: skipEmpty(writes.writeTogether, () => undefined),
  };
}
