// hippo.db's Reports group: the tenant reports, listings and usage reports the status verbs print.
import type { LossAversion } from '../../base/memory/memory.js';
import { type DatabaseSyncLike, withReadSnapshot } from '../../db/index.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { summarizeTokenUse } from './token-ledger.js';
import { summarizeFailures } from './failure-log.js';
import { keysetPage } from '../../base/util/keyset.js';
import type { SqlFragment } from '../../db/sql.js';
import type { CorrectionLinkPage, RawProvenancePage, ReportPage, Reports, StrengthTallies } from '../port/reports.js';
import { statusCounts, strengthTallies } from './candidates.js';
import { countOpenConflicts } from './conflicts.js';
import { countAllEntries, loadEntriesPage } from './entry-reads.js';
import { createdSinceLastSleep } from './index-and-stats.js';
import { buildStatsFromDb } from './mirrors.js';
import type { Handles, StoreFiles } from './open.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type CorrectionLinkDbRow = {
  old_id: string;
  old_created: string;
  new_id: string;
  corrected_at: string;
  source_created: string | null;
};

/** The ` AND` range that resumes after `after` on the given created and id columns, and the arguments it binds. */
function afterRange(created: string, id: string, after: ReportPage['after']): SqlFragment {
  if (!after) return { sql: '', params: [] };
  return {
    sql: ` AND ${created} >= ? AND (${created} > ? OR ${id} > ?)`,
    params: [after.created, after.created, after.id],
  };
}

/** A page of the superseded rows joined to their successor and that row's extraction source: the pairs the report
 * lists, and no other row. */
function correctionLinks(db: DatabaseSyncLike, page: ReportPage): CorrectionLinkPage {
  const range = afterRange('old.created', 'old.id', page.after);
  const rows = cachedStatement(
    db,
    `SELECT old.id AS old_id, old.created AS old_created, new.id AS new_id, new.created AS corrected_at,
       src.created AS source_created
     FROM memories old JOIN memories new ON new.id = old.superseded_by
     LEFT JOIN memories src ON new.extracted_from <> '' AND src.id = new.extracted_from
     WHERE old.superseded_by IS NOT NULL AND old.superseded_by != ''${range.sql}
     ORDER BY old.created ASC, old.id ASC LIMIT ?`,
  ).all(...range.params, page.limit + 1) as CorrectionLinkDbRow[];
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
function rawProvenance(db: DatabaseSyncLike, page: ReportPage): RawProvenancePage {
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
    ).all(...range.params, page.limit + 1) as Array<{
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
function memoryStatus(
  db: DatabaseSyncLike,
  rules: LossAversion,
  tenantId: string,
  now: Date,
  atRiskBelow: number,
): StrengthTallies & { openConflicts: number } {
  return withReadSnapshot(db, () => ({
    ...strengthTallies(db, rules, tenantId, now, atRiskBelow),
    openConflicts: countOpenConflicts(db, tenantId),
  }));
}

// The two totals read side tables only, so they skip the mirror setup the memory reads open with.
const reportTotalsBodies: Bodies<Pick<Reports, 'tokenUse' | 'failures'>> = {
  tokenUse: summarizeTokenUse,
  failures: summarizeFailures,
};

type Scored = 'memoryStatus' | 'statusCounts';

// These two score strength, so they score by the store's loss-aversion rules.
function scoredReadsBodies(files: StoreFiles): Bodies<Pick<Reports, Scored>> {
  return {
    memoryStatus: (db, ...args) => memoryStatus(db, files, ...args),
    statusCounts: (db, ...args) => statusCounts(db, files, ...args),
  };
}

const reportReadsBodies: Bodies<Omit<Reports, 'tokenUse' | 'failures' | Scored>> = {
  entriesPage: loadEntriesPage,
  countEntries: countAllEntries,
  stats: buildStatsFromDb,
  correctionLinks: correctionLinks,
  rawProvenance: rawProvenance,
  createdSinceLastSleep: createdSinceLastSleep,
};

export function sqliteReports({ on, files }: Handles): Reports {
  return {
    ...bound(on, reportTotalsBodies),
    ...bound(on, reportReadsBodies, openStore),
    ...bound(on, scoredReadsBodies(files), openStore),
  };
}
