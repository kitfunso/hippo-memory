// hippo.db's half of the AuditMaintenance and LessonWrites store groups: the quality audit, audit prune and git learn's
// batch.
import { pruneAuditRowsAt } from '../audit.js';
import { loadTextsHoldingWordsAt } from '../candidates.js';
import { deleteEntriesAutomaticallyAt, memoriesBackingObjectsAt } from '../delete-and-batch.js';
import { contentsWithTagAt } from '../entry-reads.js';
import { writeEntriesSkippingRejectedAt, writeEntriesTogetherAt } from '../entry-writes.js';
import { updateStatsAt } from '../index-and-stats.js';
import { type Handles, openStore } from '../open.js';
import type { AuditMaintenance, LessonWrites, Sync } from '../port.js';
import { repairAutomaticMemories, repairQualityOnce } from '../quality-repair.js';
import { touchableScopeSql } from '../rule-sql.js';

export function sqliteAuditMaintenance({ on, files }: Handles): Sync<AuditMaintenance> {
  return {
    objectBackedIds: () => on((db) => memoriesBackingObjectsAt(db)),
    deleteAutomatically: (removals, actor) =>
      removals.length === 0 ? [] : on((db, own) => deleteEntriesAutomaticallyAt(db, own, removals, actor), openStore),
    pruneAuditRows: (prune) => on((db) => pruneAuditRowsAt(db, prune)),
    // Quality repair opens the store unmigrated, so it takes the folder and not a handle.
    repairQuality: (tenantId, apply, protect) => repairAutomaticMemories(files, { tenantId, apply, protect }),
    repairQualityOnce: (tenantId, protect) => repairQualityOnce(files, tenantId, protect),
  };
}

export function sqliteLessonWrites({ on }: Handles): Sync<LessonWrites> {
  return {
    textsHoldingWords: (tenantId, words, ownScope) =>
      on((db) => loadTextsHoldingWordsAt(db, tenantId, words, undefined, touchableScopeSql('', ownScope)), openStore),
    contentsWithTag: (tenantId, tag, origins) => on((db) => contentsWithTagAt(db, tenantId, tag, origins), openStore),
    writeSkippingRejected(entries, actor) {
      const written: string[] = [];
      on((db, files) => writeEntriesSkippingRejectedAt(
        db,
        files,
        (put) => {
          for (const entry of entries) if (put(entry)) written.push(entry.id);
        },
        actor,
      ), openStore);
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
