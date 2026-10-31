// hippo.db's Reports group: the tenant reports and listings the status verbs print.
import { withReadSnapshot } from '../../db/index.js';
import { strengthTalliesAt } from '../candidates.js';
import { countOpenConflictsAt } from '../conflicts.js';
import { countAllEntries, loadEntriesPage } from '../entry-reads.js';
import { onHandle, openStore } from '../open.js';
import type { Reports } from '../port-groups.js';
import type { Sync } from '../port.js';
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
  };
}

/** The group as a served store answers it: a throw rejects as another store's would. */
export function servedReports(sync: Sync<Reports>): Reports {
  return {
    tokenUse: async (tenantId, sinceIso) => sync.tokenUse(tenantId, sinceIso),
    failures: async (tenantId, sinceIso) => sync.failures(tenantId, sinceIso),
    memoryStatus: async (tenantId, now, atRiskBelow) => sync.memoryStatus(tenantId, now, atRiskBelow),
    entriesPage: async (tenantId, page) => sync.entriesPage(tenantId, page),
    countEntries: async () => sync.countEntries(),
  };
}
