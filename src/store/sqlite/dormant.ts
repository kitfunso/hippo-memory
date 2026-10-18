// hippo.db's Dormant group: the memories sleep set aside, listed, restored or forgotten for good.
import { withWriteScope, withWriteScopeOr, type DatabaseSyncLike } from '../../db/index.js';
import type { StoreFiles, OnHandle } from './open.js';
import type { MemoryEntry } from '../../core/memory.js';
import { type SqlFragment, touchableScopeSql } from './rule-sql.js';
import type { WriteBudget } from '../../util/write-budget.js';
import { RejectedValueError } from '../../core/api-errors.js';
import { DAY_MS } from '../../util/time.js';
import { appendAuditEvent } from './audit.js';
import { audit, auditRejectionRefusal } from './audit-event.js';
import { entryIdTakenAt } from './entry-reads.js';
import { writeEntryDbOnly, writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import type { DormantSnapshot } from '../port/agent-import.js';
import type { DormantMemory, DormantRestoreOutcome, ListDormantOpts } from '../port/dormant.js';
import { updateStatsUnlessBusyAt } from './index-and-stats.js';
import type { Dormant } from '../port-groups.js';
import type { Sync } from '../port.js';
import { openStore } from './handles.js';
import { deleteDormantRow, EVERY_SCOPE, hasDormantRow, listDormantRows, readDormantSnapshot } from './dormant-rows.js';

/** Dormant memories: what sleep does with a faded memory instead of deleting it (config `dormant.enabled`;
 * `retentionDays` bounds how long one is kept). Content stays in `dormant_memories` (schema v44) and the `memories` row
 * goes, so every reader of `memories` stops seeing it, as if deleted. Not the raw archive (`raw_archive`,
 * `archiveRawMemory`), which keeps metadata only. db-taking helpers leave the handle and transaction to the caller. */

interface DormantKey {
  readonly tenantId: string;
  readonly id: string;
}

function expiredDormantKeys(db: DatabaseSyncLike, cutoffIso: string): DormantKey[] {
  const sql = `SELECT tenant_id AS tenantId, id FROM dormant_memories WHERE dormant_at < ?`;
  // SAFETY: rows' shape matches the two columns named in the SELECT.
  return db.prepare(sql).all(cutoffIso) as DormantKey[];
}

function deleteExpiredDormantRow(db: DatabaseSyncLike, key: DormantKey, cutoffIso: string): number {
  const sql = `DELETE FROM dormant_memories WHERE tenant_id = ? AND id = ? AND dormant_at < ?`;
  return Number(db.prepare(sql).run(key.tenantId, key.id, cutoffIso).changes ?? 0);
}

/** Deletes `keys` in transactions of about `budget.holdMs`, letting other writers in between; returns how many went. */
async function expireInChunks(
  db: DatabaseSyncLike,
  keys: readonly DormantKey[],
  cutoffIso: string,
  budget: WriteBudget,
): Promise<number> {
  let gone = 0;
  let next = 0;
  let committedAt = 0;
  while (next < keys.length) {
    if (next > 0) await budget.pause(committedAt);
    withWriteScope(db, 'expire_dormant_chunk', () => {
      const begunAt = budget.clock();
      do gone += deleteExpiredDormantRow(db, keys[next++], cutoffIso);
      while (next < keys.length && budget.clock() - begunAt < budget.holdMs);
    });
    committedAt = budget.clock();
  }
  return gone;
}

/** Deletes for good every memory that went dormant before `cutoffIso`, on one handle; returns how many went, or under
 * `dryRun` how many would. */
export async function expireDormantBeforeAt(
  db: DatabaseSyncLike,
  cutoffIso: string,
  opts: { dryRun: boolean; budget: WriteBudget },
): Promise<number> {
  // The keys come from a read, so a run with nothing to expire never takes the write lock.
  const keys = expiredDormantKeys(db, cutoffIso);
  return opts.dryRun ? keys.length : await expireInChunks(db, keys, cutoffIso, opts.budget);
}

/** A tenant's dormant memories whose scope `admit` passes, newest first, read on a handle of its own. */
function loadDormantMemoriesAt(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: ListDormantOpts = {},
  admit: SqlFragment = EVERY_SCOPE,
): DormantMemory[] {
  return listDormantRows(db, tenantId, opts, admit);
}

/** Whether a tenant holds a dormant memory with this id whose scope `admit` passes, read on a handle of its own. */
function holdsDormantMemoryAt(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  admit: SqlFragment = EVERY_SCOPE,
): boolean {
  return hasDormantRow(db, tenantId, id, admit);
}

/** One restore as the store applies it. The two functions are the caller's policy over plain rows; neither is handed
 * the handle. */
interface DormantRestore {
  readonly tenantId: string;
  readonly id: string;
  /** Who restores, for the audit rows. */
  readonly actor: string;
  /** False for a snapshot this caller may not touch, which then reads as missing. */
  readonly inReach: (scope: string | null) => boolean;
  /** The live memory the snapshot comes back as at `now`; a throw refuses before any write. */
  readonly revive: (snapshot: DormantSnapshot, now: Date) => MemoryEntry;
}

function auditDormantRestore(
  db: DatabaseSyncLike,
  restore: DormantRestore,
  snapshot: DormantSnapshot,
  now: Date,
): void {
  appendAuditEvent(db, {
    tenantId: restore.tenantId,
    actor: restore.actor,
    op: 'dormant_restore',
    targetId: restore.id,
    metadata: {
      reason: snapshot.reason,
      strengthAtDormancy: snapshot.strength,
      dormantAt: snapshot.dormantAt,
      daysDormant: Math.max(0, (now.getTime() - Date.parse(snapshot.dormantAt)) / DAY_MS),
    },
  });
}

function restoreInWriteScope(db: DatabaseSyncLike, hippoRoot: string, restore: DormantRestore): DormantRestoreOutcome {
  return withWriteScopeOr<DormantRestoreOutcome, DormantRestoreOutcome>(db, 'restore_dormant', (rollback) => {
    const snapshot = readDormantSnapshot(db, restore.tenantId, restore.id);
    if (!snapshot || !restore.inReach(snapshot.entry.scope ?? null)) return rollback({ status: 'missing' });
    if (entryIdTakenAt(db, restore.id)) return rollback({ status: 'active' });
    const now = new Date();
    const entry = stampOriginProject(hippoRoot, restore.revive(snapshot, now));
    writeEntryDbOnly(db, entry, { actor: restore.actor });
    deleteDormantRow(db, restore.tenantId, restore.id);
    // A restore is a labelled "forgot it, then needed it" event, the signal a learned lifecycle trains on.
    // Same write scope as the restore, so the label exists exactly when the restore does.
    auditDormantRestore(db, restore, snapshot, now);
    return { status: 'restored', entry };
  });
}

/** Brings one dormant memory back on a single handle: the live row, the dormant delete and the audit row commit
 * together, then its mirrors are written. */
function restoreDormantMemoryAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  restore: DormantRestore,
): DormantRestoreOutcome {
  let outcome: DormantRestoreOutcome;
  try {
    outcome = restoreInWriteScope(db, hippoRoot, restore);
  } catch (error) {
    // Written after the rollback, so the refusal row outlives it.
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, restore.actor);
    throw error;
  }
  if (outcome.status === 'restored') writeEntryMirrors(hippoRoot, outcome.entry);
  return outcome;
}

/** One permanent delete of a dormant memory. */
interface DormantForget {
  readonly tenantId: string;
  readonly id: string;
  /** Who forgets, for the audit row. */
  readonly actor: string;
  /** The scopes this caller may touch; a row outside them reads as missing. */
  readonly admit: SqlFragment;
}

/** Deletes a tenant's dormant memory for good and writes its `forget` audit row, on a single handle; false when it
 * holds none `admit` passes. */
function forgetDormantMemoryAt(db: DatabaseSyncLike, forget: DormantForget): boolean {
  const { tenantId, id, actor, admit } = forget;
  if (!hasDormantRow(db, tenantId, id, admit) || !deleteDormantRow(db, tenantId, id)) return false;
  // Best-effort, like every other forget audit row: the delete stands.
  audit(db, 'forget', { tenantId, actor, targetId: id, metadata: { dormant: true } });
  return true;
}

export function sqliteDormant(on: OnHandle): Sync<Dormant> {
  return {
    list: (tenantId, ownScope, opts) =>
      on((db) => loadDormantMemoriesAt(db, tenantId, opts, touchableScopeSql('', ownScope))),
    holds: (tenantId, ownScope, id) =>
      on((db) => holdsDormantMemoryAt(db, tenantId, id, touchableScopeSql('', ownScope))),
    restore: (tenantId, request) => on((db, files) => restoreDormantMemoryAt(db, files, { ...request, tenantId })),
    forget(tenantId, ownScope, id, actor) {
      const admit = touchableScopeSql('', ownScope);
      return on((db, files) => {
        if (!forgetDormantMemoryAt(db, { tenantId, id, actor, admit })) return false;
        // Counted like every other permanent removal (forget, archiveRaw).
        updateStatsUnlessBusyAt(db, files, { forgotten: 1 }, `removed ${id}`);
        return true;
      }, openStore);
    },
  };
}
