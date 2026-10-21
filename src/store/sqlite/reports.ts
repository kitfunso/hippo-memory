// hippo.db's Reports group: the tenant reports, listings and usage reports the status verbs print.
import type { LossAversion } from '../../base/memory/memory.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { summarizeTokenUse } from './token-ledger.js';
import { summarizeFailures } from './failure-log.js';
import type { CorrectionLink, RawProvenance, StrengthTallies, Reports } from '../port/reports.js';
import { statusCountsAt, strengthTalliesAt } from './candidates.js';
import { countOpenConflictsAt } from './conflicts.js';
import { countAllEntriesAt, loadEntriesPageAt } from './entry-reads.js';
import { createdSinceLastSleepAt } from './index-and-stats.js';
import { buildStatsFromDb } from './mirrors.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, type Bodies, type FileBodies } from './bound.js';
import type { Sync } from './served.js';

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type CorrectionLinkDbRow = { old_id: string; new_id: string; corrected_at: string; source_created: string | null };

/** Each superseded row joined to its successor and that row's extraction source: the pairs the report lists, and no
 * other row. */
function correctionLinksAt(db: DatabaseSyncLike): CorrectionLink[] {
  const rows = cachedStatement(
    db,
    `SELECT old.id AS old_id, new.id AS new_id, new.created AS corrected_at, src.created AS source_created
     FROM memories old JOIN memories new ON new.id = old.superseded_by
     LEFT JOIN memories src ON new.extracted_from <> '' AND src.id = new.extracted_from
     WHERE old.superseded_by IS NOT NULL AND old.superseded_by != ''
     ORDER BY old.created ASC, old.id ASC`,
  ).all() as CorrectionLinkDbRow[];
  return rows.map((r) => ({
    oldId: r.old_id,
    newId: r.new_id,
    correctedAt: r.corrected_at,
    sourceCreated: r.source_created,
  }));
}

const RAW = "kind = 'raw'";

/** The raw count in SQL and only the raw rows missing provenance, on one snapshot. */
function rawProvenanceAt(db: DatabaseSyncLike): RawProvenance {
  return withReadSnapshot(db, () => {
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const { n } = cachedStatement(db, `SELECT COUNT(*) AS n FROM memories WHERE ${RAW}`).get() as { n: number };
    // SAFETY: the SELECT names exactly these three columns.
    const gaps = cachedStatement(
      db,
      `SELECT id, owner, artifact_ref FROM memories WHERE ${RAW} ` +
        `AND (COALESCE(owner, '') = '' OR COALESCE(artifact_ref, '') = '') ORDER BY created ASC, id ASC`,
    ).all() as Array<{ id: string; owner: string | null; artifact_ref: string | null }>;
    return { total: Number(n), gaps: gaps.map((g) => ({ id: g.id, owner: g.owner, artifactRef: g.artifact_ref })) };
  });
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
  correctionLinks: correctionLinksAt,
  rawProvenance: rawProvenanceAt,
  createdSinceLastSleep: createdSinceLastSleepAt,
};

export function sqliteReports(on: OnHandle): Sync<Reports> {
  return {
    ...bound(on, reportTotalsAt),
    ...bound(on, reportReadsAt, openStore),
    ...boundWithFiles(on, scoredReadsAt, openStore),
  };
}
