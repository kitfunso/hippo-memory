// hippo.db's Reports group: the tenant reports, listings and usage reports the status verbs print.
import type { LossAversion } from '../../base/memory/memory.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { summarizeTokenUse } from './token-ledger.js';
import { summarizeFailures } from './failure-log.js';
import { keysetPage } from '../../base/util/keyset.js';
import type { SqlAnd } from './keyset.js';
import type { CorrectionLinkPage, RawProvenancePage, ReportPage, StrengthTallies } from '../port/reports.js';
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

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type CorrectionLinkDbRow = {
  old_id: string;
  old_created: string;
  new_id: string;
  corrected_at: string;
  source_created: string | null;
};

/** The ` AND` range that resumes after `after` on the given created and id columns, and the arguments it binds. */
function afterRange(created: string, id: string, after: ReportPage['after']): SqlAnd {
  if (!after) return { sql: '', args: [] };
  return {
    sql: ` AND ${created} >= ? AND (${created} > ? OR ${id} > ?)`,
    args: [after.created, after.created, after.id],
  };
}

/** A page of the superseded rows joined to their successor and that row's extraction source: the pairs the report
 * lists, and no other row. */
function correctionLinksAt(db: DatabaseSyncLike, page: ReportPage): CorrectionLinkPage {
  const range = afterRange('old.created', 'old.id', page.after);
  const rows = cachedStatement(
    db,
    `SELECT old.id AS old_id, old.created AS old_created, new.id AS new_id, new.created AS corrected_at,
       src.created AS source_created
     FROM memories old JOIN memories new ON new.id = old.superseded_by
     LEFT JOIN memories src ON new.extracted_from <> '' AND src.id = new.extracted_from
     WHERE old.superseded_by IS NOT NULL AND old.superseded_by != ''${range.sql}
     ORDER BY old.created ASC, old.id ASC LIMIT ?`,
  ).all(...range.args, page.limit + 1) as CorrectionLinkDbRow[];
  const kept = keysetPage(rows, page.limit, (r) => ({ created: r.old_created, id: r.old_id }));
  return {
    links: kept.rows.map((r) => ({
      oldId: r.old_id,
      newId: r.new_id,
      correctedAt: r.corrected_at,
      sourceCreated: r.source_created,
    })),
    next: kept.next,
  };
}

const RAW = "kind = 'raw'";

/** The raw count in SQL and a page of the raw rows missing provenance, on one snapshot. */
function rawProvenanceAt(db: DatabaseSyncLike, page: ReportPage): RawProvenancePage {
  return withReadSnapshot(db, () => {
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const { n } = cachedStatement(db, `SELECT COUNT(*) AS n FROM memories WHERE ${RAW}`).get() as { n: number };
    const range = afterRange('created', 'id', page.after);
    // SAFETY: the SELECT names exactly these four columns.
    const gaps = cachedStatement(
      db,
      `SELECT id, owner, artifact_ref, created FROM memories WHERE ${RAW} ` +
        `AND (COALESCE(owner, '') = '' OR COALESCE(artifact_ref, '') = '')${range.sql} ` +
        `ORDER BY created ASC, id ASC LIMIT ?`,
    ).all(...range.args, page.limit + 1) as Array<{
      id: string;
      owner: string | null;
      artifact_ref: string | null;
      created: string;
    }>;
    const kept = keysetPage(gaps, page.limit, (g) => ({ created: g.created, id: g.id }));
    return {
      total: Number(n),
      gaps: kept.rows.map((g) => ({ id: g.id, owner: g.owner, artifactRef: g.artifact_ref })),
      next: kept.next,
    };
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
