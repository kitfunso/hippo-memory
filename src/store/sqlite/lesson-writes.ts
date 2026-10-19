// hippo.db's LessonWrites group: git learn's batch, with the word and tag reads it checks first.
import { loadTextsHoldingWordsAt } from './candidates.js';
import { contentsWithTagAt } from './entry-reads.js';
import { writeEntriesSkippingRejectedAt, writeEntriesTogetherAt } from './entry-writes.js';
import { updateStatsAt } from './index-and-stats.js';
import type { Handles, StoreFiles } from './open.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../core/memory.js';
import { bound, boundWithFiles, skipEmpty, type Bodies, type FileBodies } from './bound.js';
import { openStore } from './handles.js';
import type { LessonWrites } from '../port.js';
import type { Sync } from './served.js';
import { touchableScopeSql } from './rule-sql.js';

/** `entries` in order, each one a rejection refuses left out; returns the ids written. */
function writeSkippingRejectedAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entries: readonly MemoryEntry[],
  actor: string,
): string[] {
  const written: string[] = [];
  writeEntriesSkippingRejectedAt(
    db,
    files,
    (put) => {
      for (const entry of entries) if (put(entry)) written.push(entry.id);
    },
    actor,
  );
  return written;
}

const lessonReadsAt: Bodies<Pick<LessonWrites, 'textsHoldingWords' | 'contentsWithTag'>> = {
  textsHoldingWords: (db, tenantId, words, ownScope) =>
    loadTextsHoldingWordsAt(db, tenantId, words, undefined, touchableScopeSql('', ownScope)),
  contentsWithTag: contentsWithTagAt,
};

const lessonWritesAt: FileBodies<Omit<LessonWrites, 'textsHoldingWords' | 'contentsWithTag'>> = {
  writeSkippingRejected: writeSkippingRejectedAt,
  writeTogether: (db, files, entries) => {
    writeEntriesTogetherAt(db, files, entries);
  },
  bumpRemembered: (db, files, count) => updateStatsAt(db, files, { remembered: count }),
};

export function sqliteLessonWrites({ on }: Handles): Sync<LessonWrites> {
  const writes = boundWithFiles(on, lessonWritesAt, openStore);
  return {
    ...bound(on, lessonReadsAt, openStore),
    ...writes,
    writeTogether: skipEmpty(writes.writeTogether, () => undefined),
  };
}
