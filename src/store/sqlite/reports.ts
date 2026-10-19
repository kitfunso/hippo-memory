// hippo.db's Reports group: the tenant reports, listings and usage reports the status verbs print.
import type { MemoryEntry } from '../../core/memory.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { summarizeTokenUse } from './token-ledger.js';
import type { TokenSummary } from '../port/token-ledger.js';
import { summarizeFailures } from './failure-log.js';
import type { FailureSummary } from '../port/failure-log.js';
import { statusCountsAt, strengthTalliesAt } from './candidates.js';
import { countOpenConflictsAt } from './conflicts.js';
import { countAllEntriesAt, loadEntriesPageAt } from './entry-reads.js';
import { createdSinceLastSleepAt } from './index-and-stats.js';
import { buildStatsFromDb } from './mirrors.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import type { Reports } from '../port-groups.js';
import type { Sync } from '../port.js';

/** Every superseded row, the row that replaced it and that row's extraction source, in loadAllEntries' order: all a
 * correction-latency report reads. */
function correctionEntriesAt(db: DatabaseSyncLike): MemoryEntry[] {
  const superseded = `superseded_by IS NOT NULL AND superseded_by != ''`;
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS} FROM memories
    WHERE (${superseded})
      OR id IN (SELECT superseded_by FROM memories WHERE ${superseded})
      OR id IN (
        SELECT extracted_from FROM memories
        WHERE extracted_from IS NOT NULL AND id IN (SELECT superseded_by FROM memories WHERE ${superseded})
      )
    ORDER BY created ASC, id ASC
  `)
    .all() as MemoryRow[];
  return rows.map(rowToEntry);
}

/** The kind='raw' rows in loadAllEntries' order: all a provenance-coverage report reads. */
function rawEntriesAt(db: DatabaseSyncLike): MemoryEntry[] {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' ORDER BY created ASC, id ASC`)
    .all() as MemoryRow[];
  return rows.map(rowToEntry);
}

/** One tenant's token ledger totals since `sinceIso`. */
function tokenUseSummaryAt(db: DatabaseSyncLike, tenantId: string, sinceIso: string): TokenSummary {
  return summarizeTokenUse(db, tenantId, sinceIso);
}

/** One tenant's failure log totals since `sinceIso`. */
function failureLogSummaryAt(db: DatabaseSyncLike, tenantId: string, sinceIso: string): FailureSummary {
  return summarizeFailures(db, tenantId, sinceIso);
}

export function sqliteReports(on: OnHandle): Sync<Reports> {
  return {
    tokenUse: (tenantId, sinceIso) => on((db) => tokenUseSummaryAt(db, tenantId, sinceIso)),
    failures: (tenantId, sinceIso) => on((db) => failureLogSummaryAt(db, tenantId, sinceIso)),
    memoryStatus(tenantId, now, atRiskBelow) {
      // One snapshot, so the tallies and the conflict count never straddle another process's write.
      return on(
        (db, files) =>
          withReadSnapshot(db, () => ({
            ...strengthTalliesAt(db, tenantId, now, atRiskBelow, files),
            openConflicts: countOpenConflictsAt(db, tenantId),
          })),
        openStore,
      );
    },
    entriesPage: (tenantId, page) => on((db) => loadEntriesPageAt(db, tenantId, page), openStore),
    countEntries: () => on((db) => countAllEntriesAt(db), openStore),
    stats: () => on(buildStatsFromDb, openStore),
    statusCounts: (now, atRiskBelow) => on((db, files) => statusCountsAt(db, now, atRiskBelow, files), openStore),
    correctionEntries: () => on(correctionEntriesAt, openStore),
    rawEntries: () => on(rawEntriesAt, openStore),
    createdSinceLastSleep: (tenantId, now) => on((db) => createdSinceLastSleepAt(db, tenantId, now), openStore),
  };
}
