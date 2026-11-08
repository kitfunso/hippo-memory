// A dirty summary's rebuild hold, one `meta` row per summary: {"failures": n, "retryAfter": ISO | null}.
// When a hold ends is decided in src/domain/consolidate/retry-holds.ts.
import { DAG_LEVEL } from '../../../base/memory/entry.js';
import { type DatabaseSyncLike, withWriteScope } from '../../../db/index.js';
import { assertTenantId } from '../../../base/scope/tenant-id.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type { Consolidation } from '../../../base/ports/store/consolidation.js';

/** The meta key prefix of a summary's hold; the summary's id follows. */
export const REBUILD_HOLD_KEY = 'rebuild_hold:';
// The first key past every hold key, as ';' follows ':'.
const REBUILD_HOLD_END = 'rebuild_hold;';
// substr is 1-based, so this is the first character of the id.
const ID_FROM = REBUILD_HOLD_KEY.length + 1;

type RebuildFailure = Parameters<NonNullable<Consolidation['noteRebuildFailures']>>[0][number];

/** SQL for the failure count of the hold row `alias`; 0 when it has none, is not JSON or holds no
 * integer count, so one bad row never stops a rebuild. The nested CASE keeps json_type off bad
 * JSON. */
export const holdFailuresSql = (alias: string): string =>
  `CASE WHEN json_valid(${alias}.value) THEN ` +
  `CASE WHEN json_type(${alias}.value, '$.failures') = 'integer' ` +
  `THEN json_extract(${alias}.value, '$.failures') ELSE 0 END ELSE 0 END`;

/** SQL for the ISO time the hold row `alias` ends; NULL when there is none. */
export const holdRetryAfterSql = (alias: string): string =>
  `CASE WHEN json_valid(${alias}.value) THEN json_extract(${alias}.value, '$.retryAfter') END`;

/** How many dirty live summaries are held after `at`, from the hold keys alone so the read grows
 * with held rows, not with the queue. */
export function heldSummaryCount(db: DatabaseSyncLike, at: string): number {
  // SAFETY: the SQL names n, the only key of the row.
  const row = cachedStatement(
    db,
    `SELECT COUNT(*) AS n
       FROM meta h JOIN memories m ON m.id = substr(h.key, ${ID_FROM})
      WHERE h.key > '${REBUILD_HOLD_KEY}' AND h.key < '${REBUILD_HOLD_END}'
        AND m.summary_dirty = 1 AND m.kind != 'archived'
        AND ${holdRetryAfterSql('h')} > ?`,
  ).get(at) as { n: number };
  return row.n;
}

/** Ends the summary's hold; the settle that landed it calls this in its own write scope. */
export function clearRebuildHold(db: DatabaseSyncLike, summaryId: string): void {
  cachedStatement(db, 'DELETE FROM meta WHERE key = ?').run(`${REBUILD_HOLD_KEY}${summaryId}`);
}

// Writes only while the stored count is still the one the caller saw, and only for a summary
// that is dirty and live: a settle that ended the hold in between wins.
const NOTE_FAILURE_SQL = `INSERT INTO meta(key, value)
  SELECT ?, ?
   WHERE EXISTS (SELECT 1 FROM memories
                  WHERE id = ? AND tenant_id = ?
                    AND dag_level IN (${DAG_LEVEL.topic}, ${DAG_LEVEL.entity})
                    AND summary_dirty = 1 AND kind != 'archived')
     AND COALESCE((SELECT ${holdFailuresSql('h')} FROM meta h WHERE h.key = ?), 0) = ?
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

// A hold left for a summary that is gone, archived or clean would hold it again once it is dirty.
const SWEEP_SQL = `DELETE FROM meta
  WHERE key > '${REBUILD_HOLD_KEY}' AND key < '${REBUILD_HOLD_END}'
    AND NOT EXISTS (SELECT 1 FROM memories m
                     WHERE m.id = substr(meta.key, ${ID_FROM})
                       AND m.summary_dirty = 1 AND m.kind != 'archived')`;

/** Stores each failure's count and hold time in one write, then drops the holds of summaries that
 * are no longer dirty. */
export function noteRebuildFailures(
  db: DatabaseSyncLike,
  failed: ReadonlyArray<RebuildFailure>,
): void {
  if (failed.length === 0) return;
  for (const item of failed) assertTenantId('noteRebuildFailures', item.tenantId);
  withWriteScope(db, 'rebuild_hold', () => {
    const note = cachedStatement(db, NOTE_FAILURE_SQL);
    for (const { id, tenantId, priorFailures, failures, retryAfter } of failed) {
      const key = `${REBUILD_HOLD_KEY}${id}`;
      note.run(key, JSON.stringify({ failures, retryAfter }), id, tenantId, key, priorFailures);
    }
    cachedStatement(db, SWEEP_SQL).run();
  });
}
