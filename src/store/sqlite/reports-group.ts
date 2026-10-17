// hippo.db's Reports group: the tenant reports and listings the status verbs print.
import { withReadSnapshot } from '../../db/index.js';
import { statusCountsAt, strengthTalliesAt } from '../candidates.js';
import { countOpenConflictsAt } from '../conflicts.js';
import { countAllEntries, loadEntriesPage } from '../entry-reads.js';
import { createdSinceLastSleepAt } from '../index-and-stats.js';
import { buildStatsFromDb } from '../mirrors.js';
import { onHandle, openStore } from '../open.js';
import type { Reports } from '../port-groups.js';
import type { Sync } from '../port.js';
import { correctionEntriesAt, rawEntriesAt } from '../report-reads.js';
import { failureLogSummary, tokenUseSummary } from '../usage-reports.js';

export function sqliteReports(hippoRoot: string): Sync<Reports> {
  return {
    tokenUse: (tenantId, sinceIso) => tokenUseSummary(hippoRoot, tenantId, sinceIso),
    failures: (tenantId, sinceIso) => failureLogSummary(hippoRoot, tenantId, sinceIso),
    memoryStatus(tenantId, now, atRiskBelow) {
      // One snapshot, so the tallies and the conflict count never straddle another process's write.
      return onHandle(hippoRoot, (db) => withReadSnapshot(db, () => ({
        ...strengthTalliesAt(db, tenantId, now, atRiskBelow),
        openConflicts: countOpenConflictsAt(db, tenantId),
      })), openStore);
    },
    entriesPage: (tenantId, page) => loadEntriesPage(hippoRoot, tenantId ?? undefined, page),
    countEntries: () => countAllEntries(hippoRoot),
    stats: () => onHandle(hippoRoot, buildStatsFromDb, openStore),
    statusCounts: (now, atRiskBelow) => onHandle(hippoRoot, (db) => statusCountsAt(db, now, atRiskBelow), openStore),
    correctionEntries: () => onHandle(hippoRoot, correctionEntriesAt, openStore),
    rawEntries: () => onHandle(hippoRoot, rawEntriesAt, openStore),
    createdSinceLastSleep: (tenantId, now) =>
      onHandle(hippoRoot, (db) => createdSinceLastSleepAt(db, tenantId, now), openStore),
  };
}
