// Dormant memories: list, restore, forget and check.

import { openHippoDb, closeHippoDb } from '../db.js';
import { ConflictError, NotFoundError } from '../api-errors.js';
import { auditRejectionRefusal } from '../store/audit-event.js';
import { stampOriginProject } from '../store/entry-row.js';
import { writeEntryDbOnly, writeEntryMirrors } from '../store/entry-writes.js';
import { updateStatsUnlessBusy } from '../store/index-and-stats.js';
import { RejectedValueError } from '../rejection.js';
import {
  listDormantRows,
  readDormantSnapshot,
  deleteDormantRow,
  hasDormantRow,
  type DormantMemory,
  type ListDormantOpts,
} from '../dormant.js';
import { createMemory, calculateStrength, type MemoryEntry } from '../memory.js';
import { appendAuditEvent, reportAuditWriteFailure } from '../audit.js';
import { loadConfig } from '../config.js';
import type { Context } from './types.js';

/**
 * A tenant's dormant memories (src/dormant.ts): what sleep moved out of
 * active memory instead of deleting, when `dormant.enabled` is on. Newest
 * first; `opts.query` keeps rows containing every term (case-insensitive).
 */
export function listDormant(ctx: Context, opts: ListDormantOpts = {}): DormantMemory[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return listDormantRows(db, ctx.tenantId, opts);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Bring a dormant memory back into active memory. It returns as if just
 * recalled: `last_retrieved` is now, so it gets a full half-life before it
 * can fade again. Every other field is the snapshot taken when it went
 * dormant.
 *
 * Throws when the tenant has no dormant memory with that id (another
 * tenant's id reads the same way), when a live memory already holds the id,
 * and RejectedValueError when the value has been rejected since. On any
 * throw the dormant copy stays where it is.
 */
export function restoreDormant(ctx: Context, id: string): MemoryEntry {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    let restored: MemoryEntry;
    db.exec('BEGIN IMMEDIATE');
    try {
      const dormant = readDormantSnapshot(db, ctx.tenantId, id);
      if (!dormant) {
        throw new NotFoundError(`dormant memory not found: ${id}`);
      }
      if (db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(id) !== undefined) {
        throw new ConflictError(`memory ${id} is already active; forget it before restoring its dormant copy`);
      }
      const now = new Date();
      // Dormant rows are long-lived, so a snapshot can predate a field added
      // later: createMemory supplies a default for anything it lacks, then
      // the snapshot overrides every field it does carry, content included.
      // (The placeholder only satisfies createMemory's minimum length, so a
      // legacy row shorter than 3 chars can still be restored.)
      const revived: MemoryEntry = {
        ...createMemory('dormant snapshot defaults', { baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays }),
        ...dormant.entry,
        last_retrieved: now.toISOString(),
      };
      restored = stampOriginProject(ctx.hippoRoot, { ...revived, strength: calculateStrength(revived, now) });
      writeEntryDbOnly(db, restored, { actor: ctx.actor.subject });
      deleteDormantRow(db, ctx.tenantId, id);
      // A restore is a labelled "forgot it, then needed it" event: the
      // signal a learned lifecycle trains on. Same transaction
      // as the restore, so the label exists exactly when the restore does.
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor.subject,
        op: 'dormant_restore',
        targetId: id,
        metadata: {
          reason: dormant.reason,
          strengthAtDormancy: dormant.strength,
          dormantAt: dormant.dormantAt,
          daysDormant: Math.max(0, (now.getTime() - Date.parse(dormant.dormantAt)) / (24 * 60 * 60 * 1000)),
        },
      });
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      if (err instanceof RejectedValueError) {
        auditRejectionRefusal(db, err, ctx.actor.subject);
      }
      throw err;
    }
    writeEntryMirrors(ctx.hippoRoot, restored);
    return restored;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Permanently delete a dormant memory: the explicit "forget it for good"
 * that dormant storage leaves to the user. Throws when the tenant has no
 * dormant memory with that id.
 */
export function forgetDormant(ctx: Context, id: string): void {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    if (!deleteDormantRow(db, ctx.tenantId, id)) {
      throw new NotFoundError(`dormant memory not found: ${id}`);
    }
    try {
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor.subject,
        op: 'forget',
        targetId: id,
        metadata: { dormant: true },
      });
    } catch (error) {
      // Best-effort, like every other forget audit row: the delete stands.
      reportAuditWriteFailure('forget', String(error), id);
    }
  } finally {
    closeHippoDb(db);
  }
  // Counted like every other permanent removal (forget, archiveRaw).
  updateStatsUnlessBusy(ctx.hippoRoot, { forgotten: 1 }, `removed ${id}`);
}

/** Whether the tenant holds a dormant memory with this id (for "not found" hints). */
export function isDormant(ctx: Context, id: string): boolean {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return hasDormantRow(db, ctx.tenantId, id);
  } finally {
    closeHippoDb(db);
  }
}
