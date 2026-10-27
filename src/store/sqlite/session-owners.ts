// hippo.db's session-owner binding: the first owner a session id is bound to.
import {
  HOOK_DB_WAIT_MS,
  sessionOf,
  withWriteScope,
  type DatabaseSyncLike,
} from '../../db/index.js';
import { raiseMinBinary } from '../../db/meta.js';
import { TASK_OWNER_MIN_BINARY } from '../../base/util/version.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { handleNow, handleStamp } from './handle-clock.js';
/** The owner a session id is bound to, or null. */
function readSessionOwner(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
): string | null {
  const row = cachedStatement(
    db,
    `SELECT owner_subject FROM session_owners WHERE tenant_id = ? AND session_id = ?`,
  ).get(tenantId, sessionId) as { owner_subject: string } | undefined;
  return row?.owner_subject ?? null;
}

/** A session's first owner and when it was bound. */
interface OwnerRowOptions {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly owner: string;
  readonly createdAt: string;
}

/** Binds `sessionId` to `owner` unless a binding exists; the count is 1 when this call bound it. */
function insertOwnerRow(
  db: DatabaseSyncLike,
  { tenantId, sessionId, owner, createdAt }: OwnerRowOptions,
): number {
  const result = cachedStatement(
    db,
    `INSERT OR IGNORE INTO session_owners(tenant_id, session_id, owner_subject, created_at) VALUES (?, ?, ?, ?)`,
  ).run(tenantId, sessionId, owner, createdAt);
  return Number(result.changes ?? 0);
}

/** Drops bindings created before `cutoffIso`, by idx_session_owners_created_at. */
function deleteSessionOwnersBefore(db: DatabaseSyncLike, cutoffIso: string): void {
  cachedStatement(db, `DELETE FROM session_owners WHERE created_at < ?`).run(cutoffIso);
}

/** One caller's claim on a session id. */
interface SessionOwnerBinding {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly owner: string;
  /** Bindings older than this are pruned in the write that adds a new one. */
  readonly retentionMs: number;
}

/** Binds under the write lock and returns the stored owner, which is not `owner` when a
 * concurrent first bind won. */
function insertSessionOwner(db: DatabaseSyncLike, binding: SessionOwnerBinding): string | null {
  const { tenantId, sessionId, owner, retentionMs } = binding;
  withWriteScope(
    db,
    'bind_session_owner',
    () => {
      const row = { tenantId, sessionId, owner, createdAt: handleStamp(db) };
      const bound = insertOwnerRow(db, row);
      // An older binary supersedes across owners, so the first binding shuts it out in the same
      // transaction.
      if (bound === 1) raiseMinBinary(db, TASK_OWNER_MIN_BINARY);
      // Pruned on write, as the failure log is; a pruned session id is a UUID no other caller
      // knows.
      deleteSessionOwnersBefore(db, new Date(handleNow(db).getTime() - retentionMs).toISOString());
    },
    { busyWaitMs: sessionOf(db)?.busyWaitMs ?? HOOK_DB_WAIT_MS },
  );
  // Re-read, since a concurrent first bind may have won the INSERT OR IGNORE.
  return readSessionOwner(db, tenantId, sessionId);
}

/** The owner stored for the session id, binding `binding.owner` first when none is stored. */
export function sessionOwnerOrBind(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  owner: string,
  retentionMs: number,
): string | null {
  // A bound session is the common case after the first prompt, so it must not take the write lock.
  return (
    readSessionOwner(db, tenantId, sessionId) ??
    insertSessionOwner(db, { tenantId, sessionId, owner, retentionMs })
  );
}
