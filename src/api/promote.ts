// Promote to the global store, supersede with a successor, and archive raw memories.

import { openHippoDb, closeHippoDb, isSqliteBusy, type DatabaseSyncLike } from '../db.js';
import { ConflictError, NotFoundError } from '../api-errors.js';
import { auditRejectionRefusal } from '../store/audit-event.js';
import { stampOriginProject } from '../store/entry-row.js';
import { removeEntryMirrors } from '../store/mirrors.js';
import { writeEntryDbOnly, writeEntryMirrors } from '../store/entry-writes.js';
import { readEntry } from '../store/entry-reads.js';
import { updateStatsUnlessBusy } from '../store/index-and-stats.js';
import { markSummaryDirtyInTx } from '../summary-dirty.js';
import { RejectedValueError } from '../rejection.js';
import { log } from '../log.js';
import { createSuccessor, type MemoryEntry } from '../memory.js';
import { appendAuditEvent } from '../audit.js';
import { promoteToGlobal } from '../shared.js';
import { archiveRawMemory } from '../raw-archive.js';
import { loadConfig } from '../config.js';
import type { Context } from './types.js';
import { selectMemoryTenant } from '../store/tenant-lookup.js';

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

/**
 * Copy a local memory into the global store. Mirrors `cmdPromote` in cli.ts:
 * the `writeEntry` inside `promoteToGlobal` emits a 'remember' on the global
 * db; we add a 'promote' audit event on the global db so the user-facing
 * intent stays distinct from the underlying upsert.
 *
 * Note: `promoteToGlobal` does not currently take a tenantId override — it
 * reads the entry from the local root via `readEntry` (no tenant filter) and
 * preserves the entry's existing tenantId on the global side.
 */
export interface PromoteResult {
  ok: true;
  sourceId: string;
  globalId: string;
}
export function promote(
  ctx: Context,
  id: string,
): PromoteResult {
  // Tenant scope: promoteToGlobal reads the entry from the local root via
  // readEntry without a tenant filter, so a Bearer for tenant A could
  // promote tenant B's row by guessing or leaking the id. Pre-check the
  // row's tenant_id and deny cross-tenant access with the same not-found
  // wording archiveRaw uses (no info leak about whether the id exists in
  // another tenant).
  const ownerDb = openHippoDb(ctx.hippoRoot);
  try {
    if (selectMemoryTenant(ownerDb, id) !== ctx.tenantId) {
      throw new NotFoundError(`memory not found: ${id}`);
    }
  } finally {
    closeHippoDb(ownerDb);
  }

  // The 'promote' row commits with the global copy, so no write follows the commit and a busy store fails the whole promote.
  const globalEntry = promoteToGlobal(ctx.hippoRoot, id, {
    actor: ctx.actor.subject,
    tenantId: ctx.tenantId,
    afterWrite: (db, globalId) => appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor.subject,
      op: 'promote',
      targetId: globalId,
      metadata: { sourceId: id },
    }),
  });

  return { ok: true, sourceId: id, globalId: globalEntry.id };
}

// ---------------------------------------------------------------------------
// supersede
// ---------------------------------------------------------------------------

/**
 * Replace an old memory with new content, chaining old.superseded_by = new.id.
 * Mirrors `cmdSupersede` in cli.ts minus the flag-driven layer/tag/pin
 * overrides: the CLI handler resolves those so the API stays minimal.
 */
export interface SupersedeResult {
  ok: true;
  oldId: string;
  newId: string;
}
export function supersede(
  ctx: Context,
  oldId: string,
  newContent: string,
): SupersedeResult {
  const old = readSupersedable(ctx, oldId);

  const newEntry = createSuccessor(old, newContent, {
    tenantId: ctx.tenantId,
    baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
  });

  // Race-safe transition: open a fresh db handle, BEGIN IMMEDIATE, run all
  // three steps (CAS on old + writeEntryDbOnly(new) + supersede audit row)
  // inside the same transaction. Two concurrent supersedes: exactly one CAS
  // wins (changes=1), the other gets changes=0 and throws CONFLICT. No
  // dangling-pointer window: the new memory's row commits atomically with
  // the old.superseded_by pointer.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    commitSupersede(db, ctx, oldId, old, newEntry);
    // Mirrors after COMMIT, while the db handle is still open. Same
    // invariant as the original writeEntry: a mirror failure leaves disk
    // MISSING the markdown for the new memory (rebuildIndex rewrites every
    // markdown mirror from the DB) but DOES NOT desync the DB or
    // roll back the supersede. Logged + swallowed, non-fatal.
    try {
      writeEntryMirrors(ctx.hippoRoot, newEntry);
    } catch (mirrorErr) {
      log.error(`supersede: mirror write failed (non-fatal, will self-heal): ${mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)}`);
    }
  } finally {
    closeHippoDb(db);
  }

  return { ok: true, oldId, newId: newEntry.id };
}

/** The tenant-scoped row to supersede; readEntry's tenant filter makes another tenant's id read as not found. */
function readSupersedable(ctx: Context, oldId: string): MemoryEntry {
  const old: MemoryEntry | null = readEntry(ctx.hippoRoot, oldId, ctx.tenantId);
  if (!old) {
    throw new NotFoundError(`Memory not found: ${oldId}`);
  }
  // The CAS UPDATE closes the race; this check only gives a clearer error in the common single-writer case.
  if (old.superseded_by) {
    throw new ConflictError(
      `Memory ${oldId} is already superseded by ${old.superseded_by}. Supersede that one instead.`,
    );
  }
  return old;
}

/** CAS on the old row, the successor's insert and the 'supersede' audit row, in one BEGIN IMMEDIATE transaction. */
function commitSupersede(db: DatabaseSyncLike, ctx: Context, oldId: string, old: MemoryEntry, newEntry: MemoryEntry): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // The tenant filter repeats readEntry's check at no cost, closing an ownership change between read and update.
    const result = db.prepare(`
      UPDATE memories
      SET superseded_by = ?
      WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL
    `).run(newEntry.id, oldId, ctx.tenantId);
    if ((result.changes ?? 0) === 0) {
      db.exec('ROLLBACK');
      throw new ConflictError(`Memory ${oldId} already superseded by another writer`);
    }
    // After the CAS guard, so a lost race throws before the old parent is marked for rebuild.
    if (old.dag_parent_id) {
      markSummaryDirtyInTx(db, old.dag_parent_id, ctx.tenantId, ctx.actor.subject);
    }
    // Emits its own 'remember' audit row inside the same transaction.
    writeEntryDbOnly(db, stampOriginProject(ctx.hippoRoot, newEntry), { actor: ctx.actor.subject });
    appendAuditEvent(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor.subject,
      op: 'supersede',
      targetId: oldId,
      metadata: { newId: newEntry.id },
    });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    // The refusal audit lands after ROLLBACK, in a fresh implicit transaction the aborted one cannot undo.
    if (err instanceof RejectedValueError) {
      auditRejectionRefusal(db, err, ctx.actor.subject);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// archive_raw
// ---------------------------------------------------------------------------

/**
 * Archive a kind='raw' memory: snapshot into raw_archive, mark archived, delete.
 *
 * `archiveRawMemory` audits the operation internally (op='archive_raw') using the
 * row's own tenant_id. We DO NOT emit a second audit event here to avoid double-
 * emitting the archive_raw op. Instead we pass `ctx.actor.subject` through as `who`,
 * and raw-archive.ts uses that for the audit row.
 */
export interface ArchiveRawOpts {
  /**
   * Connector idempotency hook. Runs inside the same
   * SAVEPOINT as the archive — throwing rolls the archive back. Used by the
   * Slack deletion connector to mark the deletion event seen atomically.
   */
  afterArchive?: (db: DatabaseSyncLike, archivedMemoryId: string) => void;
}

export interface ArchiveRawResult {
  ok: true;
  archivedAt: string;
}
export function archiveRaw(
  ctx: Context,
  id: string,
  reason: string,
  opts: ArchiveRawOpts = {},
): ArchiveRawResult {
  const db = openHippoDb(ctx.hippoRoot);
  let mirrorOk = false;
  try {
    // Tenant scope: archiveRawMemory looks up the row by id alone, so a
    // Bearer for tenant A could archive tenant B's raw row without this
    // pre-check. Deny cross-tenant access with the same not-found message
    // archiveRawMemory itself would throw on a missing row, so we don't
    // leak whether the id exists in another tenant.
    if (selectMemoryTenant(db, id) !== ctx.tenantId) {
      throw new NotFoundError(`memory not found: ${id}`);
    }
    archiveRawMemory(db, id, {
      reason,
      who: ctx.actor.subject,
      afterArchive: opts.afterArchive,
    });
    // archiveRawMemory deletes the memories row but leaves any legacy markdown
    // mirror in <root>/{buffer,episodic,semantic}/<id>.md untouched. If we left
    // the mirror in place, a subsequent initStore() on an empty memories table
    // would silently re-import the row via bootstrapLegacyStore — defeating the
    // archive (and the GDPR right-to-be-forgotten promise on raw rows). Mirror
    // forget() at src/store.ts:1046, which uses the same removeEntryMirrors call.
    // The DB transaction has already committed; if filesystem unlink fails here
    // we log and continue. The mirror reaper in openHippoDb will catch it on
    // next DB open: raw_archive.mirror_cleaned_at stays NULL until every layer
    // mirror for this id is gone, so the reaper genuinely retries.
    try {
      removeEntryMirrors(ctx.hippoRoot, id);
      mirrorOk = true;
    } catch (mirrorErr) {
      log.error(`archiveRaw: mirror cleanup failed for ${id} (will retry via reaper on next openHippoDb): ${mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)}`);
    }
    if (mirrorOk) {
      // Stamp mirror_cleaned_at now so the next openHippoDb reaper SELECT
      // returns empty for this row. NULL stays untouched on failure -> retry.
      try {
        db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
          new Date().toISOString(),
          id,
        );
      } catch (err) {
        if (!isSqliteBusy(err)) throw err;
        log.warnThenDebug('archive-mirror-stamp-busy', `archived ${id}; the store was busy, so the mirror reaper will re-check it on the next open`);
      }
    }
  } finally {
    closeHippoDb(db);
  }
  // Counted here rather than in the CLI: the HTTP archive route calls this too,
  // so a routed archive would otherwise never reach the forgotten counter.
  updateStatsUnlessBusy(ctx.hippoRoot, { forgotten: 1 }, `removed ${id}`);
  // archiveRawMemory does not return the archive_at timestamp it wrote. We
  // emit a fresh ISO timestamp here for the API response. Within a millisecond
  // of the actual write, fine for a server response shape.
  return { ok: true, archivedAt: new Date().toISOString() };
}
