// A session id belongs to the first owner that binds it, so one developer's client cannot write into another's session.
import { ConflictError } from './api-errors.js';
import { ownerOrSubject, type Context } from './api/types.js';
import { closeHippoDb, HOOK_DB_WAIT_MS, openHippoDb, scopedBusyWait, withWriteScope, type DatabaseSyncLike } from './db.js';
import { raiseMinBinary } from './db/meta.js';
import { deleteSessionOwnersBeforeAt, insertSessionOwnerAt, selectSessionOwnerAt } from './store/sessions.js';
import { assertTenantId } from './tenant.js';
import { TASK_OWNER_MIN_BINARY } from './version.js';
import { DAY_MS } from './util/time.js';

/** Bindings older than this are pruned when a new session binds. */
const BINDING_RETENTION_DAYS = 90;

function boundOwner(db: DatabaseSyncLike, tenantId: string, sessionId: string): string | null {
  return selectSessionOwnerAt(db, tenantId, sessionId);
}

/** Binds under the write lock and returns the stored owner, which is not `owner` when a concurrent first bind won. */
export function insertBinding(db: DatabaseSyncLike, tenantId: string, sessionId: string, owner: string): string | null {
  withWriteScope(db, 'bind_session_owner', () => {
    const bound = insertSessionOwnerAt(db, tenantId, sessionId, owner, new Date().toISOString());
    // An older binary supersedes across owners, so the first binding shuts it out in the same transaction.
    if (bound === 1) raiseMinBinary(db, TASK_OWNER_MIN_BINARY);
    // Pruned on write, as the failure log is; a pruned session id is a UUID no other caller knows.
    deleteSessionOwnersBeforeAt(db, new Date(Date.now() - BINDING_RETENTION_DAYS * DAY_MS).toISOString());
  }, { busyWaitMs: scopedBusyWait() ?? HOOK_DB_WAIT_MS });
  // Re-read, since a concurrent first bind may have won the INSERT OR IGNORE.
  return boundOwner(db, tenantId, sessionId);
}

/** Binds `sessionId` to the caller's owner on first use; a session another owner holds is a 409, so the client can set it aside. */
export function bindSessionOwner(ctx: Context, sessionId: string): void {
  assertTenantId('bindSessionOwner', ctx.tenantId);
  const owner = ownerOrSubject(ctx.actor);
  const db = openHippoDb(ctx.hippoRoot);
  try {
    // A bound session is the common case after the first prompt, so it must not take the write lock.
    const bound = boundOwner(db, ctx.tenantId, sessionId) ?? insertBinding(db, ctx.tenantId, sessionId, owner);
    if (bound !== owner) throw new ConflictError('session id belongs to another caller');
  } finally {
    closeHippoDb(db);
  }
}
