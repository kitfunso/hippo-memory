// hippo.db's Dormant group: the memories sleep set aside, listed, restored or forgotten for good.
import { withWriteScope, withWriteScopeOr, type DatabaseSyncLike } from '../../db/index.js';
import type { Handles, StoreFiles } from './open.js';
import { touchableScopeSql } from './rule-sql.js';
import type { SqlFragment } from '../../db/sql.js';
import type { WriteBudget } from '../../base/util/write-budget.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { reviveDormant } from '../../base/memory/dormant-revival.js';
import { ownScopeTouches } from '../../base/scope/recall-scope.js';
import { DAY_MS } from '../../base/util/time.js';
import { appendAuditEvents } from './audit.js';
import { audit, auditRejectionRefusal } from './audit-event.js';
import { entryIdTaken } from './entry-reads.js';
import { writeEntryDbOnly, writeEntryMirrors } from './entry-writes.js';
import { stampOriginProject } from './entry-row.js';
import type { DormantRestoreOutcome, Dormant, DormantRestoreRequest } from '../port/dormant.js';
import { updateStatsUnlessBusy } from './index-and-stats.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import { deleteDormantRow, hasDormantRow, listDormantRows, readDormantSnapshot } from './dormant-rows.js';
import type { DormantSnapshot } from '../port/types.js';
import { cachedStatement } from '../../db/statement-cache.js';

/** Dormant memories: what sleep does with a faded memory instead of deleting it (config `dormant.enabled`;
 * `retentionDays` bounds how long one is kept). Content stays in `dormant_memories` (schema v44) and the `memories` row
 * goes, so every reader of `memories` stops seeing it, as if deleted. Not the raw archive (`raw_archive`,
 * `archiveRawMemory`), which keeps metadata only. db-taking helpers leave the handle and transaction to the caller. */

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface DormantKey {
  readonly tenantId: string;
  readonly id: string;
}

function expiredDormantKeys(db: DatabaseSyncLike, cutoffIso: string): DormantKey[] {
  const sql = `SELECT tenant_id AS tenantId, id FROM dormant_memories WHERE dormant_at < ?`;
  return cachedStatement(db, sql).all(cutoffIso) as DormantKey[];
}

function deleteExpiredDormantRow(db: DatabaseSyncLike, key: DormantKey, cutoffIso: string): number {
  const sql = `DELETE FROM dormant_memories WHERE tenant_id = ? AND id = ? AND dormant_at < ?`;
  return Number(cachedStatement(db, sql).run(key.tenantId, key.id, cutoffIso).changes ?? 0);
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
export async function expireDormantBefore(
  db: DatabaseSyncLike,
  cutoffIso: string,
  opts: { dryRun: boolean; budget: WriteBudget },
): Promise<number> {
  // The keys come from a read, so a run with nothing to expire never takes the write lock.
  const keys = expiredDormantKeys(db, cutoffIso);
  return opts.dryRun ? keys.length : await expireInChunks(db, keys, cutoffIso, opts.budget);
}

/** One restore as the store applies it: the caller's request with its tenant. */
type DormantRestore = DormantRestoreRequest & { readonly tenantId: string };

function auditDormantRestore(
  db: DatabaseSyncLike,
  restore: DormantRestore,
  snapshot: DormantSnapshot,
  now: Date,
): void {
  appendAuditEvents(db, [
    {
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
    },
  ]);
}

function restoreInWriteScope(db: DatabaseSyncLike, files: StoreFiles, restore: DormantRestore): DormantRestoreOutcome {
  return withWriteScopeOr<DormantRestoreOutcome, DormantRestoreOutcome>(db, 'restore_dormant', (rollback) => {
    const snapshot = readDormantSnapshot(db, restore.tenantId, restore.id);
    if (!snapshot || !ownScopeTouches(restore.ownScope, snapshot.entry.scope ?? null)) {
      return rollback({ status: 'missing' });
    }
    if (entryIdTaken(db, restore.id)) return rollback({ status: 'active' });
    const now = new Date();
    const entry = stampOriginProject(files, reviveDormant(snapshot, now, restore.revival));
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
function restoreDormantMemory(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  request: DormantRestoreRequest,
): DormantRestoreOutcome {
  const restore: DormantRestore = { ...request, tenantId };
  let outcome: DormantRestoreOutcome;
  try {
    outcome = restoreInWriteScope(db, files, restore);
  } catch (error) {
    // Written after the rollback, so the refusal row outlives it.
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, restore.actor);
    throw error;
  }
  if (outcome.status === 'restored') writeEntryMirrors(files.hippoRoot, outcome.entry);
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
function forgetDormantMemory(db: DatabaseSyncLike, forget: DormantForget): boolean {
  const { tenantId, id, actor, admit } = forget;
  if (!hasDormantRow(db, tenantId, id, admit) || !deleteDormantRow(db, tenantId, id)) return false;
  // Best-effort, like every other forget audit row: the delete stands.
  audit(db, 'forget', { tenantId, actor, targetId: id, metadata: { dormant: true } });
  return true;
}

// The port names the caller's own scope; the rows take the SQL that admits it.
const dormantReadsBodies: Bodies<Pick<Dormant, 'list' | 'holds'>> = {
  list: (db, tenantId, ownScope, opts) => listDormantRows(db, tenantId, opts, touchableScopeSql('', ownScope)),
  holds: (db, tenantId, ownScope, id) => hasDormantRow(db, tenantId, id, touchableScopeSql('', ownScope)),
};

export function sqliteDormant({ on, files }: Handles): Dormant {
  return {
    ...bound(on, dormantReadsBodies),
    ...bound<Pick<Dormant, 'restore'>>(on, { restore: (db, ...args) => restoreDormantMemory(db, files, ...args) }),
    ...bound<Pick<Dormant, 'forget'>>(
      on,
      {
        forget: (db, tenantId, ownScope, id, actor) => {
          if (!forgetDormantMemory(db, { tenantId, id, actor, admit: touchableScopeSql('', ownScope) })) return false;
          // Counted like every other permanent removal (forget, archiveRaw).
          updateStatsUnlessBusy(db, files, { forgotten: 1 }, `removed ${id}`);
          return true;
        },
      },
      openStore,
    ),
  };
}
