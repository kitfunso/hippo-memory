// hippo.db's Reports group: the tenant reports and listings the status verbs print.
import { withReadSnapshot } from '../../db/index.js';
import { statusCountsAt, strengthTalliesAt } from '../candidates.js';
import { countOpenConflictsAt } from '../conflicts.js';
import { countAllEntriesAt, loadEntriesPageAt } from '../entry-reads.js';
import { createdSinceLastSleepAt } from '../index-and-stats.js';
import { buildStatsFromDb } from '../mirrors.js';
import { openStore, type OnHandle } from '../open.js';
import type { Reports } from '../port-groups.js';
import type { Sync } from '../port.js';
import { correctionEntriesAt, rawEntriesAt } from '../report-reads.js';
import { failureLogSummaryAt, tokenUseSummaryAt } from '../usage-reports.js';

export function sqliteReports(on: OnHandle): Sync<Reports> {
  return {
    tokenUse: (tenantId, sinceIso) => on((db) => tokenUseSummaryAt(db, tenantId, sinceIso)),
    failures: (tenantId, sinceIso) => on((db) => failureLogSummaryAt(db, tenantId, sinceIso)),
    memoryStatus(tenantId, now, atRiskBelow) {
      // One snapshot, so the tallies and the conflict count never straddle another process's write.
      return on((db) => withReadSnapshot(db, () => ({
        ...strengthTalliesAt(db, tenantId, now, atRiskBelow),
        openConflicts: countOpenConflictsAt(db, tenantId),
      })), openStore);
    },
    entriesPage: (tenantId, page) => on((db) => loadEntriesPageAt(db, tenantId ?? undefined, page), openStore),
    countEntries: () => on((db) => countAllEntriesAt(db), openStore),
    stats: () => on(buildStatsFromDb, openStore),
    statusCounts: (now, atRiskBelow) => on((db) => statusCountsAt(db, now, atRiskBelow), openStore),
    correctionEntries: () => on(correctionEntriesAt, openStore),
    rawEntries: () => on(rawEntriesAt, openStore),
    createdSinceLastSleep: (tenantId, now) => on((db) => createdSinceLastSleepAt(db, tenantId, now), openStore),
  };
}
