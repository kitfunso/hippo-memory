import type { MemoryEntry } from '../memory.js';
import { closeHippoDb, type DatabaseSyncLike, withWriteScope } from '../db.js';
import { assertTenantId } from '../tenant.js';
import { findRejectedValue, rejectionDigest } from './rejection.js';
import { log } from '../log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { audit } from './audit-event.js';
import { syncFtsRow } from './entry-row.js';
import { openStore } from './open.js';

// ---------------------------------------------------------------------------
// Dirty-flag helpers for DAG summaries: child writes mark a summary dirty, and the
// sleep-cycle rebuild enumerates candidates without scanning every memory row.
// ---------------------------------------------------------------------------

/**
 * Mark a summary as dirty. Idempotent (re-marking dirty is a no-op + no
 * second audit row). Tenant-scoped to prevent cross-tenant writes via
 * parent-lookup. Called from invalidation.ts / writeEntry /
 * forgetMemory / archiveRawMemory whenever a child is invalidated,
 * superseded, forgotten, or archived.
 *
 * Quietly no-ops if the target row doesn't exist or isn't a level-2/3
 * summary. Emits a 'summary_marked_dirty' audit row on actual
 * state transitions (0 -> 1) via the audit() helper, which try/catches
 * for missing audit_log (the v27 self-heal scenario).
 */
export function markSummaryDirty(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
  actor: string = 'cli',
): void {
  assertTenantId('markSummaryDirty', tenantId);
  const db = openStore(hippoRoot);
  try {
    // RETURNING dag_level reads the actual level in the same round trip.
    // SAFETY: result's shape matches the single `dag_level` column returned
    // above.
    const result = db.prepare(`
      UPDATE memories
         SET summary_dirty = 1
       WHERE id = ?
         AND tenant_id = ?
         AND dag_level IN (2, 3)
         AND summary_dirty = 0
         AND kind != 'archived'
      RETURNING dag_level
    `).get(summaryId, tenantId) as { dag_level: number } | undefined;
    if (result) {
      // audit() wraps appendAuditEvent in try/catch (v27 heal scenario).
      // metadata.source tells this dirty-mark apart from the other wiring layers' marks.
      audit(db, 'summary_marked_dirty', { targetId: summaryId, metadata: { dag_level: result.dag_level, source: 'E1' }, actor, tenantId });
    }
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Sleep-cycle rebuild surface.
//
// loadAllDirtySummaries / loadChildrenOfSummary / applyRebuildResult /
// clearSummaryDirtyAfterBuild live HERE (not in dag.ts) because they need
// module-private MEMORY_SELECT_COLUMNS, MemoryRow, rowToEntry, audit,
// syncFtsRow, assertTenantId. dag.ts owns only the thin orchestrator
// rebuildDirtySummaries() that calls into these.
// ---------------------------------------------------------------------------

/**
 * Host-wide loader for L2 topic summaries without an L3 parent.
 * Used by consolidate phase 1.9 (buildEntityProfiles) to cluster L2s into
 * L3 entity profiles. Mirrors loadAllDirtySummaries: SQL-level
 * filter is cheaper than reusing in-memory `survivors` (which doesn't
 * contain L2s freshly created by phase 1.7 buildDag).
 *
 * Returns entries with tenantId attached so per-cluster writes stay
 * tenant-scoped via summary.tenantId.
 */
export function loadAllL2Summaries(hippoRoot: string): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Dirty summaries, newest change first. Iterates all tenants
 * in one query so consolidate.ts (host-wide per L106-109) does not need a
 * per-tenant loop. Each returned MemoryEntry carries its own tenantId (via
 * rowToEntry), so per-summary children + rebuild UPDATE stay tenant-scoped.
 *
 * Sort: latest_at DESC NULLS LAST, id ASC — same as per-tenant variant so
 * HIPPO_DAG_REBUILD_CAP takes most-recently-changed summaries first.
 */
export function loadAllDirtySummaries(hippoRoot: string): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load live children of a DAG summary. Used by
 * rebuildDirtySummaries to regenerate content from the CURRENT child set
 * (not the children at create-time). Skips archived. Tenant-scoped
 * (defence in depth — dag_parent_id is unique-ish but tenant guard is
 * cheap). created column is TEXT NOT NULL since db.ts schema v1.
 */
export function loadChildrenOfSummary(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
): MemoryEntry[] {
  assertTenantId('loadChildrenOfSummary', tenantId);
  const db = openStore(hippoRoot);
  try {
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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Patch applied by applyRebuildResult. Two-branch shape
 * (bumpRebuildCount false for zero-child case, true for normal rebuild).
 */
export interface RebuildPatch {
  content: string;            // new content for normal rebuild; summary.content for zero-child
  descendant_count: number;
  earliest_at: string | null;
  latest_at: string | null;
  bumpRebuildCount: boolean;
  zeroChildren: boolean;
  actor: string;
}

/**
 * Apply a rebuild result to a dirty summary. Atomic: one
 * prepared UPDATE statement plus syncFtsRow inside one write scope.
 * WHERE includes `AND summary_dirty = 1` so concurrent sleep's race-loser
 * becomes a no-op (no rebuild_count bump, no audit row).
 *
 * Returns `{ changed, refused }`. `changed` is true when this call's UPDATE
 * (content or metadata-only) affected a row; false on race-loss / unknown id
 * / archived / wrong dag_level. `refused` is true only when a tombstone hit
 * suppressed the content write AND the metadata UPDATE still landed — see
 * the return-semantics comment below for the full contract.
 */
export function applyRebuildResult(
  hippoRoot: string,
  summary: MemoryEntry,
  patch: RebuildPatch,
) {
  assertTenantId('applyRebuildResult', summary.tenantId);
  const db = openStore(hippoRoot);
  try {
    return withWriteScope(db, 'rebuild_summary', () => applyRebuildInSavepoint(db, summary, patch));
  } finally {
    closeHippoDb(db);
  }
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
  // On a hit: do NOT write the new content. Fall through to the SAME
  // metadata-only behavior the zero-child branch already has —
  // descendant_count/earliest_at/latest_at update + summary_dirty
  // cleared, no content write, no rebuild_count bump. Clearing dirty
  // (rather than leaving it set) is deliberate: leaving it dirty would
  // make every following sleep cycle re-attempt and re-refuse the
  // identical rebuild forever (the DAG-loop this fix closes).
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
  // refused === true here (same condition, narrowed for the tombstone.*
  // access below). Best-effort refusal audit, written INLINE inside
  // this still-open SAVEPOINT — nothing here rolls back on a refusal
  // (the metadata UPDATE above already committed to this savepoint), so the
  // post-rollback auditRejectionRefusal helper (writeEntry/supersede's
  // tool) is the wrong one here; a direct audit() call is correct and
  // commits with the rest of this savepoint.
  audit(db, 'reject_refusal', { targetId: summary.id, metadata: { digest: tombstone.digest, reason: tombstone.reason }, actor: patch.actor, tenantId: summary.tenantId });
  log.warn(
    `applyRebuildResult: refused rebuild content for ${summary.id} — matches a rejected value ` +
      `(digest ${tombstone.digest.slice(0, 12)}...); metadata updated, content unchanged`,
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

/**
 * Clear summary_dirty on a freshly-built summary. Called by buildDag right after the child-link loop:
 * each member's writeEntry marks the new parent dirty, so the same cycle's rebuild would redo every new summary.
 *
 * Idempotent: no-op + no audit if summary isn't dirty. Audit
 * source='buildDag-clean' distinguishes it from the rebuild's source.
 */
export function clearSummaryDirtyAfterBuild(
  hippoRoot: string,
  summaryId: string,
  tenantId: string,
  actor: string = 'cli',
  source: string = 'buildDag-clean',
): void {
  assertTenantId('clearSummaryDirtyAfterBuild', tenantId);
  const db = openStore(hippoRoot);
  try {
    // RETURNING dag_level reads the actual level so audit metadata stays accurate without an extra SELECT.
    // SAFETY: result's shape matches the single `dag_level` column returned
    // below.
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
  } finally {
    closeHippoDb(db);
  }
}
