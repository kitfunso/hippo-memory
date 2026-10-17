// hippo.db's half of the AuditMaintenance and LessonWrites store groups: the quality audit, audit prune and git learn's
// batch.
import { pruneAuditRows } from '../audit.js';
import { loadTextsHoldingWords } from '../candidates.js';
import { deleteEntriesAutomatically, memoriesBackingObjects } from '../delete-and-batch.js';
import { contentsWithTagAt, loadAllEntries } from '../entry-reads.js';
import { writeEntriesSkippingRejected, writeEntriesTogether } from '../entry-writes.js';
import { updateStats } from '../index-and-stats.js';
import { onHandle, openStore } from '../open.js';
import type { AuditMaintenance, LessonWrites, Sync } from '../port.js';
import { repairAutomaticMemories, repairQualityOnce } from '../quality-repair.js';
import { touchableScopeSql } from '../rule-sql.js';

export function sqliteAuditMaintenance(hippoRoot: string): Sync<AuditMaintenance> {
  return {
    tenantEntries: (tenantId) => loadAllEntries(hippoRoot, tenantId),
    objectBackedIds: () => memoriesBackingObjects(hippoRoot),
    deleteAutomatically: (removals, actor) => deleteEntriesAutomatically(hippoRoot, removals, actor),
    pruneAuditRows: (prune) => pruneAuditRows(hippoRoot, prune),
    repairQuality: (tenantId, apply) => repairAutomaticMemories(hippoRoot, { tenantId, apply }),
    repairQualityOnce: (tenantId) => repairQualityOnce(hippoRoot, tenantId),
  };
}

export function sqliteLessonWrites(hippoRoot: string): Sync<LessonWrites> {
  return {
    tenantEntries: (tenantId) => loadAllEntries(hippoRoot, tenantId),
    textsHoldingWords: (tenantId, words, ownScope) =>
      loadTextsHoldingWords(hippoRoot, tenantId, words, undefined, touchableScopeSql('', ownScope)),
    contentsWithTag: (tenantId, tag, origins) =>
      onHandle(hippoRoot, (db) => contentsWithTagAt(db, tenantId, tag, origins), openStore),
    writeSkippingRejected(entries, actor) {
      const written: string[] = [];
      writeEntriesSkippingRejected(
        hippoRoot,
        (put) => {
          for (const entry of entries) if (put(entry)) written.push(entry.id);
        },
        actor,
      );
      return written;
    },
    writeTogether(entries) {
      writeEntriesTogether(hippoRoot, entries);
    },
    bumpRemembered(count) {
      updateStats(hippoRoot, { remembered: count });
    },
  };
}
