import { withWriteScope, withWriteScopeOr, type DatabaseSyncLike } from '../../../db/index.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import { touchableScopeSql } from '../runtime/rule-sql.js';
import type { SqlFragment } from '../../../db/sql.js';
import type { WriteBudget } from '../../../base/util/write-budget.js';
import { RejectedValueError } from '../../../base/errors/api-errors.js';
import { reviveDormant } from '../../../base/memory/dormant-revival.js';
import { ownScopeTouches } from '../../../base/scope/recall-scope.js';
import { DAY_MS } from '../../../base/util/time.js';
import { appendAuditEvents } from '../audit/audit.js';
import { audit, auditRejectionRefusal } from '../audit/audit-event.js';
import { entryIdTaken } from '../entries/entry-reads.js';
import { writeEntryDbOnly, writeEntryMirrors } from '../entries/entry-writes.js';
import { stampOriginProject } from '../entries/entry-row.js';
import type {
  DormantRestoreOutcome,
  Dormant,
  DormantRestoreRequest,
} from '../../../base/ports/store/dormant.js';
import { updateStatsUnlessBusy } from '../entries/index-and-stats.js';
import { openStore } from '../runtime/handles.js';
import { bound, type Bodies } from '../runtime/bound.js';
import {
  deleteDormantRow,
  hasDormantRow,
  listDormantRows,
  readDormantSnapshot,
} from './dormant-rows.js';
import type { DormantSnapshot } from '../../../base/ports/store/types.js';
import { cachedStatement } from '../../../db/statement-cache.js';

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
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

/** Deletes for good every memory that went dormant before `cutoffIso`, on one handle; returns
 * how many went, or under `dryRun` how many would. */
export async function expireDormantBefore(
  db: DatabaseSyncLike,
  cutoffIso: string,
  opts: { dryRun: boolean; budget: WriteBudget },
): Promise<number> {
  const keys = expiredDormantKeys(db, cutoffIso);
  return opts.dryRun ? keys.length : await expireInChunks(db, keys, cutoffIso, opts.budget);
}

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

function restoreInWriteScope(
  db: DatabaseSyncLike,
  files: StoreFiles,
  restore: DormantRestore,
): DormantRestoreOutcome {
  return withWriteScopeOr<DormantRestoreOutcome, DormantRestoreOutcome>(
    db,
    'restore_dormant',
    (rollback) => {
      const snapshot = readDormantSnapshot(db, restore.tenantId, restore.id);
      if (!snapshot || !ownScopeTouches(restore.ownScope, snapshot.entry.scope ?? null)) {
        return rollback({ status: 'missing' });
      }
      if (entryIdTaken(db, restore.id)) return rollback({ status: 'active' });
      const now = files.clock();
      const entry = stampOriginProject(files, reviveDormant(snapshot, now, restore.revival));
      writeEntryDbOnly(db, entry, { actor: restore.actor });
      deleteDormantRow(db, restore.tenantId, restore.id);
      auditDormantRestore(db, restore, snapshot, now);
      return { status: 'restored', entry };
    },
  );
}

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
    if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, restore.actor);
    throw error;
  }
  if (outcome.status === 'restored') writeEntryMirrors(files.hippoRoot, outcome.entry);
  return outcome;
}

interface DormantForget {
  readonly tenantId: string;
  readonly id: string;
  readonly actor: string;
  readonly admit: SqlFragment;
}

function forgetDormantMemory(db: DatabaseSyncLike, forget: DormantForget): boolean {
  const { tenantId, id, actor, admit } = forget;
  if (!hasDormantRow(db, tenantId, id, admit) || !deleteDormantRow(db, tenantId, id)) return false;
  audit(db, 'forget', { tenantId, actor, targetId: id, metadata: { dormant: true } });
  return true;
}

const dormantReadsBodies: Bodies<Pick<Dormant, 'list'>> = {
  list: (db, tenantId, ownScope, opts) =>
    listDormantRows(db, tenantId, opts, touchableScopeSql('', ownScope)),
};

export function sqliteDormant({ on, files }: Handles): Dormant {
  return {
    ...bound(on, dormantReadsBodies),
    ...bound<Pick<Dormant, 'restore'>>(on, {
      restore: (db, ...args) => restoreDormantMemory(db, files, ...args),
    }),
    ...bound<Pick<Dormant, 'forget'>>(
      on,
      {
        forget: (db, tenantId, ownScope, id, actor) => {
          if (
            !forgetDormantMemory(db, {
              tenantId,
              id,
              actor,
              admit: touchableScopeSql('', ownScope),
            })
          ) {
            return false;
          }
          updateStatsUnlessBusy(db, files, { forgotten: 1 }, `removed ${id}`);
          return true;
        },
      },
      openStore,
    ),
  };
}
