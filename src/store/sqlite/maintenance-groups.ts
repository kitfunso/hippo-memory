// hippo.db's half of the AuditMaintenance and LessonWrites store groups: the quality audit, audit prune and git learn's
// batch.
import { pruneAuditRows } from '../audit.js';
import { loadTextsHoldingWords } from '../candidates.js';
import { deleteEntriesAutomatically, memoriesBackingObjects } from '../delete-and-batch.js';
import { loadAllEntries } from '../entry-reads.js';
import { writeEntriesSkippingRejected, writeEntriesTogether } from '../entry-writes.js';
import { updateStats } from '../index-and-stats.js';
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

export function servedAuditMaintenance(sync: Sync<AuditMaintenance>): AuditMaintenance {
  return {
    tenantEntries: async (tenantId) => sync.tenantEntries(tenantId),
    objectBackedIds: async () => sync.objectBackedIds(),
    deleteAutomatically: async (removals, actor) => sync.deleteAutomatically(removals, actor),
    pruneAuditRows: async (prune) => sync.pruneAuditRows(prune),
    repairQuality: async (tenantId, apply) => sync.repairQuality(tenantId, apply),
    repairQualityOnce: async (tenantId) => sync.repairQualityOnce(tenantId),
  };
}

export function sqliteLessonWrites(hippoRoot: string): Sync<LessonWrites> {
  return {
    tenantEntries: (tenantId) => loadAllEntries(hippoRoot, tenantId),
    textsHoldingWords: (tenantId, words, ownScope) =>
      loadTextsHoldingWords(hippoRoot, tenantId, words, undefined, touchableScopeSql('', ownScope)),
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

export function servedLessonWrites(sync: Sync<LessonWrites>): LessonWrites {
  return {
    tenantEntries: async (tenantId) => sync.tenantEntries(tenantId),
    textsHoldingWords: async (tenantId, words, ownScope) => sync.textsHoldingWords(tenantId, words, ownScope),
    writeSkippingRejected: async (entries, actor) => sync.writeSkippingRejected(entries, actor),
    writeTogether: async (entries) => sync.writeTogether(entries),
    bumpRemembered: async (count) => sync.bumpRemembered(count),
  };
}
