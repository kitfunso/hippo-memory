import type { MemoryEntry } from '../core/memory.js';
import { type DatabaseSyncLike, withWriteScope } from '../db/index.js';
import { assertTenantId } from './tenant.js';
import { findRejectedValue, rejectionDigest } from './rejection.js';
import { log } from '../util/log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { audit } from './audit-event.js';
import { syncFtsRow } from './entry-row.js';
import { onHandle, openStore } from './open.js';
import { DIGEST_DISPLAY_CHARS } from '../util/token-text.js';

// Sleep-cycle rebuild surface: lives here, not in src/consolidate/dag.ts, because it needs module-private MEMORY_SELECT_COLUMNS, MemoryRow, rowToEntry,
// audit, syncFtsRow and assertTenantId. dag.ts keeps only the thin orchestrator rebuildDirtySummaries().

/** Host-wide loader for L2 topic summaries without an L3 parent, for consolidate phase 1.9 (buildEntityProfiles); SQL-level filter, since in-memory
 * `survivors` lacks L2s created by phase 1.7. Entries carry tenantId so per-cluster writes stay tenant-scoped. */
export function loadAllL2Summaries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: this query selects exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE dag_level = 2
         AND dag_parent_id IS NULL
         AND kind != 'archived'
         AND superseded_by IS NULL
       ORDER BY created ASC, id ASC
    `).all() as MemoryRow[];
    return rows.map(rowToEntry);
  }, openStore);
}

/** Dirty summaries across all tenants in one query, newest change first (latest_at DESC NULLS LAST, id ASC) so HIPPO_DAG_REBUILD_CAP takes the most
 * recently changed. Each entry carries its own tenantId so the children read and rebuild UPDATE stay tenant-scoped. */
export function loadAllDirtySummaries(hippoRoot: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: this query selects exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE summary_dirty = 1
         AND kind != 'archived'
       ORDER BY latest_at DESC NULLS LAST, id ASC
    `).all() as MemoryRow[];
    return rows.map(rowToEntry);
  }, openStore);
}

/** Live (non-archived) children of a DAG summary, so a rebuild regenerates from the CURRENT child set; tenant-scoped as defence in depth. */
export function loadChildrenOfSummary(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
): MemoryEntry[] {
  assertTenantId('loadChildrenOfSummary', tenantId);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: this query selects exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE dag_parent_id = ?
         AND tenant_id = ?
         AND kind != 'archived'
         AND superseded_by IS NULL
       ORDER BY created ASC
    `).all(summaryId, tenantId) as MemoryRow[];
    return rows.map(rowToEntry);
  }, openStore);
}

/** Patch applied by applyRebuildResult; `bumpRebuildCount` is false for the zero-child case, true for a normal rebuild. */
export interface RebuildPatch {
  content: string;            // new content for normal rebuild; summary.content for zero-child
  descendant_count: number;
  earliest_at: string | null;
  latest_at: string | null;
  bumpRebuildCount: boolean;
  zeroChildren: boolean;
  actor: string;
}

/** Apply a rebuild result to a dirty summary in one write scope (UPDATE plus syncFtsRow); `AND summary_dirty = 1` makes a concurrent race-loser a no-op.
 * Returns `{ changed, refused }`: `refused` only when a tombstone hit suppressed the content write while the metadata UPDATE still landed. */
export function applyRebuildResult(
  hippoRoot: string,
  summary: MemoryEntry,
  patch: RebuildPatch,
) {
  assertTenantId('applyRebuildResult', summary.tenantId);
  return onHandle(hippoRoot, (db) => {
    return withWriteScope(db, 'rebuild_summary', () => applyRebuildInSavepoint(db, summary, patch));
  }, openStore);
}

// ONE prepared UPDATE per branch. Test #8 inspects the SQL string.
const REBUILD_CONTENT_SQL = `UPDATE memories
              SET content = ?,
                  descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  last_rebuilt_at = ?,
                  rebuild_count = COALESCE(rebuild_count, 0) + 1,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level IN (2, 3)
              AND summary_dirty = 1
              AND kind != 'archived'`;
const REBUILD_METADATA_SQL = `UPDATE memories
              SET descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level IN (2, 3)
              AND summary_dirty = 1
              AND kind != 'archived'`;

function applyRebuildInSavepoint(
  db: DatabaseSyncLike,
  summary: MemoryEntry,
  patch: RebuildPatch,
) {
  const nowIso = new Date().toISOString();

  // Check tombstones before choosing the UPDATE: this direct UPDATE bypasses upsertEntryRow's guard, and
  // a deterministic rebuild would otherwise re-assert a rejected value every sleep cycle.
  const tombstone = patch.bumpRebuildCount
    ? findRejectedValue(db, summary.tenantId, rejectionDigest(patch.content))
    : null;
  // On a tombstone hit, write no content: take the zero-child metadata-only path (descendant_count/earliest_at/latest_at, summary_dirty cleared, no
  // rebuild_count bump). Clearing dirty is deliberate: leaving it set would make every later sleep re-attempt and re-refuse the same rebuild forever.
  const applyContentWrite = patch.bumpRebuildCount && !tombstone;

  const result = applyContentWrite
    ? db.prepare(REBUILD_CONTENT_SQL).run(
        patch.content,
        patch.descendant_count,
        patch.earliest_at,
        patch.latest_at,
        nowIso,
        summary.id,
        summary.tenantId,
      )
    : db.prepare(REBUILD_METADATA_SQL).run(
        patch.descendant_count,
        patch.earliest_at,
        patch.latest_at,
        summary.id,
        summary.tenantId,
      );

  // `changed` means THIS call's UPDATE hit a row, so a refusal still settles the cycle (false would retry
  // the doomed rebuild forever); `refused` lets the caller count it as refused rather than rebuilt.
  const changed = (result.changes ?? 0) > 0;
  const refused = Boolean(tombstone) && changed;

  if (tombstone && changed) auditRefusedRebuild(db, summary, patch, tombstone);

  if (changed) syncRebuiltSummary(db, summary, patch, applyContentWrite, nowIso);
  return { changed, refused };
}

/** Audit and log a rebuild whose content matched a rejected value; metadata still landed. */
function auditRefusedRebuild(
  db: DatabaseSyncLike,
  summary: MemoryEntry,
  patch: RebuildPatch,
  tombstone: NonNullable<ReturnType<typeof findRejectedValue>>,
): void {
  // refused === true here (narrowed for the tombstone.* access). Best-effort refusal audit written INLINE in this still-open SAVEPOINT (the metadata
  // UPDATE already committed to it), so a direct audit() call is correct, not the post-rollback auditRejectionRefusal.
  audit(db, 'reject_refusal', {
    targetId: summary.id,
    metadata: { digest: tombstone.digest, reason: tombstone.reason },
    actor: patch.actor,
    tenantId: summary.tenantId
  });
  log.warn(
    `applyRebuildResult: refused rebuild content for ${summary.id} — matches a rejected value ` +
      `(digest ${tombstone.digest.slice(0, DIGEST_DISPLAY_CHARS)}...); metadata updated, content unchanged`,
  );
}

function syncRebuiltSummary(
  db: DatabaseSyncLike,
  summary: MemoryEntry,
  patch: RebuildPatch,
  applyContentWrite: boolean,
  nowIso: string,
): void {
  // A bare UPDATE on memories does NOT update memories_fts, so resync from the patched entry;
  // content stays summary.content when the write was refused, since FTS must mirror the row.
  const patchedEntry: MemoryEntry = {
    ...summary,
    content: applyContentWrite ? patch.content : summary.content,
    descendant_count: patch.descendant_count,
    earliest_at: patch.earliest_at,
    latest_at: patch.latest_at,
    summary_dirty: 0,
    last_rebuilt_at: applyContentWrite ? nowIso : summary.last_rebuilt_at,
    rebuild_count: applyContentWrite
      ? (summary.rebuild_count ?? 0) + 1
      : summary.rebuild_count,
  };
  syncFtsRow(db, patchedEntry);

  audit(db, 'summary_rebuilt', { targetId: summary.id, metadata: {
      // Actual level from the summary in scope, never hardcoded: L2 -> 2, L3 -> 3.
      dag_level: summary.dag_level,
      source: 'E3-rebuild',
      zero_children: patch.zeroChildren,
      descendant_count: patch.descendant_count,
    }, actor: patch.actor, tenantId: summary.tenantId });
}

/** Clear summary_dirty on a new summary after buildDag's child-link loop (each member's writeEntry marks the parent dirty, so the same cycle would rebuild it).
 * Idempotent (no-op, no audit if not dirty); audit source='buildDag-clean' distinguishes it from the rebuild's. */
export function clearSummaryDirtyAfterBuild(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
  actor: string = 'cli',
  source: string = 'buildDag-clean',
): void {
  assertTenantId('clearSummaryDirtyAfterBuild', tenantId);
  onHandle(hippoRoot, (db) => {
    // RETURNING dag_level reads the actual level so audit metadata stays accurate without an extra SELECT.
    // SAFETY: result's shape matches the single `dag_level` column returned below.
    const result = db.prepare(`
      UPDATE memories
         SET summary_dirty = 0
       WHERE id = ?
         AND tenant_id = ?
         AND dag_level IN (2, 3)
         AND summary_dirty = 1
         AND kind != 'archived'
      RETURNING dag_level
    `).get(summaryId, tenantId) as { dag_level: number } | undefined;
    if (result) {
      // source tells buildDag-clean (L2) from buildEntityProfiles-clean (L3) and any future build path.
      audit(db, 'summary_marked_clean', { targetId: summaryId, metadata: { dag_level: result.dag_level, source }, actor, tenantId });
    }
  }, openStore);
}
