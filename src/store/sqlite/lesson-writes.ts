// hippo.db's LessonWrites group: git learn's batch, with the word and tag reads it checks first.
import { loadTextsHoldingWordsAt } from './candidates.js';
import { contentsWithTagAt } from './entry-reads.js';
import { writeEntriesSkippingRejectedAt, writeEntriesTogetherAt } from './entry-writes.js';
import { updateStatsAt } from './index-and-stats.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import type { LessonWrites, Sync } from '../port.js';
import { touchableScopeSql } from './rule-sql.js';

export function sqliteLessonWrites({ on }: Handles): Sync<LessonWrites> {
  return {
    textsHoldingWords: (tenantId, words, ownScope) =>
      on((db) => loadTextsHoldingWordsAt(db, tenantId, words, undefined, touchableScopeSql('', ownScope)), openStore),
    contentsWithTag: (tenantId, tag, origins) => on((db) => contentsWithTagAt(db, tenantId, tag, origins), openStore),
    writeSkippingRejected(entries, actor) {
      const written: string[] = [];
      on(
        (db, files) =>
          writeEntriesSkippingRejectedAt(
            db,
            files,
            (put) => {
              for (const entry of entries) if (put(entry)) written.push(entry.id);
            },
            actor,
          ),
        openStore,
      );
      return written;
    },
    writeTogether(entries) {
      if (entries.length > 0) on((db, files) => writeEntriesTogetherAt(db, files, entries), openStore);
    },
    bumpRemembered(count) {
      on((db, files) => updateStatsAt(db, files, { remembered: count }), openStore);
    },
  };
}
