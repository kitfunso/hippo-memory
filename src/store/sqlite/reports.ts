// hippo.db's Reports group: the tenant reports, listings and usage reports the status verbs print.
import type { LossAversion, MemoryEntry } from '../../base/memory/memory.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { summarizeTokenUse } from './token-ledger.js';
import { summarizeFailures } from './failure-log.js';
import type { StrengthTallies } from '../port/reports.js';
import { statusCountsAt, strengthTalliesAt } from './candidates.js';
import { countOpenConflictsAt } from './conflicts.js';
import { countAllEntriesAt, loadEntriesPageAt } from './entry-reads.js';
import { createdSinceLastSleepAt } from './index-and-stats.js';
import { buildStatsFromDb } from './mirrors.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, type Bodies, type FileBodies } from './bound.js';
import type { Reports } from '../port-groups.js';
import type { Sync } from './served.js';

/** Every superseded row, the row that replaced it and that row's extraction source, in loadAllEntries' order: all a
 * correction-latency report reads. */
function correctionEntriesAt(db: DatabaseSyncLike): MemoryEntry[] {
  const superseded = `superseded_by IS NOT NULL AND superseded_by != ''`;
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
  const rows = db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' ORDER BY created ASC, id ASC`)
    .all() as MemoryRow[];
  return rows.map(rowToEntry);
}

/** Strength tallies and the open-conflict count on one snapshot, so they never straddle another process's write. */
function memoryStatusAt(
  db: DatabaseSyncLike,
  rules: LossAversion,
  tenantId: string,
  now: Date,
  atRiskBelow: number,
): StrengthTallies & { openConflicts: number } {
  return withReadSnapshot(db, () => ({
    ...strengthTalliesAt(db, rules, tenantId, now, atRiskBelow),
    openConflicts: countOpenConflictsAt(db, tenantId),
  }));
}

// The two totals read side tables only, so they skip the mirror setup the memory reads open with.
const reportTotalsAt: Bodies<Pick<Reports, 'tokenUse' | 'failures'>> = {
  tokenUse: summarizeTokenUse,
  failures: summarizeFailures,
};

type Scored = 'memoryStatus' | 'statusCounts';

// These two score strength, so they take the store's loss-aversion rules beside the handle.
const scoredReadsAt: FileBodies<Pick<Reports, Scored>> = {
  memoryStatus: memoryStatusAt,
  statusCounts: statusCountsAt,
};

const reportReadsAt: Bodies<Omit<Reports, 'tokenUse' | 'failures' | Scored>> = {
  entriesPage: loadEntriesPageAt,
  countEntries: countAllEntriesAt,
  stats: buildStatsFromDb,
  correctionEntries: correctionEntriesAt,
  rawEntries: rawEntriesAt,
  createdSinceLastSleep: createdSinceLastSleepAt,
};

export function sqliteReports(on: OnHandle): Sync<Reports> {
  return {
    ...bound(on, reportTotalsAt),
    ...bound(on, reportReadsAt, openStore),
    ...boundWithFiles(on, scoredReadsAt, openStore),
  };
}
