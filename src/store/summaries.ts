import type { MemoryEntry } from '../memory.js';
import { closeHippoDb } from '../db.js';
import { assertTenantId } from '../tenant.js';
import { findRejectedValue, rejectionDigest } from '../rejection.js';
import { log } from '../log.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './rows.js';
import { audit } from './audit-event.js';
import { syncFtsRow } from './entry-row.js';
import { openStore } from './open.js';

// ---------------------------------------------------------------------------
// v0.30 / E1 of DAG live-coupling — dirty-flag helpers for the existing
// DAG layer's level-2 summaries.
//
// Used by E2 (child-write propagation in invalidation.ts / writeEntry /
// forgetMemory / archiveRawMemory) to mark a summary dirty when one of its
// children changes, and by E3's sleep-cycle rebuildDirtySummaries phase to
// enumerate candidates without scanning every memory row.
// ---------------------------------------------------------------------------

/**
 * Load summaries flagged dirty for the given tenant. Sorted by latest_at
 * DESC (NULLS LAST) so E3's rebuild cap (HIPPO_DAG_REBUILD_CAP, default 20)
 * takes the most-recently-changed summaries first.
 *
 * Returns full MemoryEntry shape via MEMORY_SELECT_COLUMNS + rowToEntry
 * (v28 fields are part of the standard read path).
 */
export function loadDirtySummaries(
  hippoRoot: string,
  tenantId: string,
): MemoryEntry[] {
  assertTenantId('loadDirtySummaries', tenantId);
  const db = openStore(hippoRoot);
  try {
    // SAFETY: this query selects exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const rows = db.prepare(`
      SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
       WHERE summary_dirty = 1
         AND tenant_id = ?
         AND kind != 'archived'
       ORDER BY latest_at DESC NULLS LAST, id ASC
    `).all(tenantId) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Mark a summary as dirty. Idempotent (re-marking dirty is a no-op + no
 * second audit row). Tenant-scoped to prevent cross-tenant writes via
 * parent-lookup. Called by E2 from invalidation.ts / writeEntry /
 * forgetMemory / archiveRawMemory whenever a child is invalidated,
 * superseded, forgotten, or archived.
 *
 * Quietly no-ops if the target row doesn't exist or isn't a level-2
 * summary (E5 will widen the dag_level guard to IN (2, 3) when level-3
 * build path lands). Emits a 'summary_marked_dirty' audit row on actual
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
    // v0.30 / E5: widened dag_level=2 -> IN (2, 3). RETURNING dag_level reads
    // actual level in same round trip.
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
      // metadata.source=E1 leaves a breadcrumb so E2-E5 debugging can
      // distinguish dirty-marks across the arc's wiring layers.
      audit(db, 'summary_marked_dirty', summaryId, { dag_level: result.dag_level, source: 'E1' }, actor, tenantId);
    }
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// v0.30 / E3 of DAG live-coupling — sleep-cycle rebuild surface.
//
// loadAllDirtySummaries / loadChildrenOfSummary / applyRebuildResult /
// clearSummaryDirtyAfterBuild live HERE (not in dag.ts) because they need
// module-private MEMORY_SELECT_COLUMNS, MemoryRow, rowToEntry, audit,
// syncFtsRow, assertTenantId. dag.ts owns only the thin orchestrator
// rebuildDirtySummaries() that calls into these.
// ---------------------------------------------------------------------------

/**
 * v0.30 / E5 — host-wide loader for L2 topic summaries without an L3 parent.
 * Used by consolidate phase 1.9 (buildEntityProfiles) to cluster L2s into
 * L3 entity profiles. Mirrors loadAllDirtySummaries pattern (E3): SQL-level
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
 * v0.30 / E3 — host-wide variant of loadDirtySummaries. Iterates all tenants
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
 * v0.30 / E3 — load live children of a DAG summary. Used by
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
 * v0.30 / E3 — patch applied by applyRebuildResult. Two-branch shape
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
 * v0.30 / E3 — apply a rebuild result to a dirty summary. Atomic: one
 * prepared UPDATE statement plus syncFtsRow inside one SAVEPOINT.
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
    db.exec('SAVEPOINT rebuild_summary');
    try {
      const nowIso = new Date().toISOString();

      // AT1 P1a fix (docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
      // applyRebuildResult's bumpRebuildCount branch wrote patch.content via
      // a direct UPDATE, bypassing the rejection guard entirely (the guard
      // lives in upsertEntryRow's INSERT path, which this function never
      // calls). A rebuild that regenerates byte-identical content to an
      // already-rejected value (e.g. deterministic summarization of an
      // unchanged child set) would silently re-assert it every sleep cycle.
      // Check BEFORE choosing which UPDATE to run — only the
      // bumpRebuildCount branch ever writes content, so a miss or a
      // zero-child call is a no-op here (one indexed point query, guarded
      // path only).
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

      // ONE prepared UPDATE per branch. Test #8 inspects the SQL string.
      // v0.30 / E5: widened dag_level=2 -> IN (2, 3) on both branches.
      const sql = applyContentWrite
        ? `UPDATE memories
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
              AND kind != 'archived'`
        : `UPDATE memories
              SET descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  summary_dirty = 0
            WHERE id = ?
              AND tenant_id = ?
              AND dag_level IN (2, 3)
              AND summary_dirty = 1
              AND kind != 'archived'`;

      const result = applyContentWrite
        ? db.prepare(sql).run(
            patch.content,
            patch.descendant_count,
            patch.earliest_at,
            patch.latest_at,
            nowIso,
            summary.id,
            summary.tenantId,
          )
        : db.prepare(sql).run(
            patch.descendant_count,
            patch.earliest_at,
            patch.latest_at,
            summary.id,
            summary.tenantId,
          );

      // Return-value semantics (v0.30/T4 split): `changed` reflects whether
      // THIS call's UPDATE (content or metadata-only) affected a row — NOT
      // whether patch.content specifically landed. On a refusal, metadata
      // still applies, so changed=true even though content did not change.
      // This preserves the pre-T4 no-infinite-retry choice: the caller
      // (dag.ts rebuildDirtySummaries) treats changed=false as "race lost,
      // silently retry next cycle" — returning false on a refusal would
      // retry the same doomed LLM rebuild forever, so changed=true settles
      // this cycle (dirty cleared) regardless of refusal.
      // `refused` is the T4 addition: true only when a tombstone hit AND
      // the metadata UPDATE landed (changed=true) — a refusal that loses
      // the race to a concurrent writer reports refused=false too, since
      // nothing from this call took effect. Before T4, a refusal also
      // counted toward the caller's `rebuilt` stat because `changed` alone
      // could not distinguish it; the caller now increments `refused`
      // instead of `rebuilt` when this is true, so the stat reflects what
      // happened without changing dirty-clearing or retry behavior.
      const changed = (result.changes ?? 0) > 0;
      const refused = Boolean(tombstone) && changed;

      if (tombstone && changed) {
        // refused === true here (same condition, narrowed for the tombstone.*
        // access below). Best-effort refusal audit, written INLINE inside
        // this still-open SAVEPOINT — nothing here rolls back on a refusal
        // (the metadata UPDATE above already committed to this savepoint), so the
        // post-rollback auditRejectionRefusal helper (writeEntry/supersede's
        // tool) is the wrong one here; a direct audit() call is correct and
        // commits with the rest of this savepoint.
        audit(
          db,
          'reject_refusal',
          summary.id,
          { digest: tombstone.digest, reason: tombstone.reason },
          patch.actor,
          summary.tenantId,
        );
        log.warn(
          `applyRebuildResult: refused rebuild content for ${summary.id} — matches a rejected value ` +
            `(digest ${tombstone.digest.slice(0, 12)}...); metadata updated, content unchanged`,
        );
      }

      if (changed) {
        // FTS sync — bare UPDATE on memories does NOT update memories_fts.
        // R1 HIGH must-fix from plan-eng-r1. Construct the patched entry in
        // memory and reuse the existing syncFtsRow helper (delete-then-insert).
        // earliest_at/latest_at preserve null semantics (R2 must-fix).
        // AT1: content stays summary.content (unchanged) when the write was
        // refused — applyContentWrite is false, so patch.content was never
        // written to the row FTS must mirror.
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

        audit(
          db,
          'summary_rebuilt',
          summary.id,
          {
            // v0.30 / E5: read actual level from the summary in scope
            // (NOT hardcoded 2). L2 -> 2, L3 -> 3.
            dag_level: summary.dag_level,
            source: 'E3-rebuild',
            zero_children: patch.zeroChildren,
            descendant_count: patch.descendant_count,
          },
          patch.actor,
          summary.tenantId,
        );
      }

      db.exec('RELEASE SAVEPOINT rebuild_summary');
      return { changed, refused };
    } catch (e) {
      try {
        db.exec('ROLLBACK TO SAVEPOINT rebuild_summary');
        db.exec('RELEASE SAVEPOINT rebuild_summary');
      } catch {
        // Ignore rollback failures — throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

/**
 * v0.30 / E3 — clear summary_dirty on a freshly-built summary. Called by
 * buildDag immediately after the child-link loop finishes. Without this,
 * each member's writeEntry call fires markSummaryDirtyInTx on the just-
 * created parent (E2 hook at store.ts:1214), and the same sleep cycle's
 * E3 rebuild phase would re-rebuild every new summary (2x LLM cost).
 *
 * Idempotent: no-op + no audit if summary isn't dirty. Audit
 * source='buildDag-clean' distinguishes from E3-rebuild source.
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
    // v0.30 / E5: widened dag_level=2 -> IN (2, 3). RETURNING dag_level reads
    // actual level so audit metadata stays accurate without an extra SELECT.
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
      // v0.30 / E5: source param distinguishes buildDag-clean (L2) from
      // buildEntityProfiles-clean (L3) and any future build path.
      audit(db, 'summary_marked_clean', summaryId, { dag_level: result.dag_level, source }, actor, tenantId);
    }
  } finally {
    closeHippoDb(db);
  }
}
