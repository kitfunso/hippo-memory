// A session id belongs to the first owner that binds it, so one developer's client cannot write into another's session.
import { ConflictError } from './api-errors.js';
import { ownerOrSubject, type Context } from './api/types.js';
import { closeHippoDb, execWithBusyRetry, HOOK_DB_WAIT_MS, openHippoDb, scopedBusyWait, type DatabaseSyncLike } from './db.js';
import { raiseMinBinary } from './db/meta.js';
import { assertTenantId } from './tenant.js';
import { TASK_OWNER_MIN_BINARY } from './version.js';

/** Bindings older than this are pruned when a new session binds. */
const BINDING_RETENTION_DAYS = 90;

function boundOwner(db: DatabaseSyncLike, tenantId: string, sessionId: string): string | null {
  // SAFETY: the SELECT names exactly this one TEXT column.
  const row = db.prepare(`SELECT owner_subject FROM session_owners WHERE tenant_id = ? AND session_id = ?`).get(tenantId, sessionId) as { owner_subject: string } | undefined;
  return row?.owner_subject ?? null;
}

function insertBinding(db: DatabaseSyncLike, tenantId: string, sessionId: string, owner: string): string | null {
  execWithBusyRetry(db, 'BEGIN IMMEDIATE', scopedBusyWait() ?? HOOK_DB_WAIT_MS);
  try {
    const result = db.prepare(`INSERT OR IGNORE INTO session_owners(tenant_id, session_id, owner_subject, created_at) VALUES (?, ?, ?, ?)`)
      .run(tenantId, sessionId, owner, new Date().toISOString());
    // An older binary supersedes across owners, so the first binding shuts it out in the same transaction.
    if (Number(result.changes ?? 0) === 1) raiseMinBinary(db, TASK_OWNER_MIN_BINARY);
    // Pruned on write, as the failure log is; a pruned session id is a UUID no other caller knows.
    // SHORTCUT: no created_at index, so each first bind scans the table; add one past a few hundred thousand rows.
    db.prepare(`DELETE FROM session_owners WHERE created_at < ?`).run(new Date(Date.now() - BINDING_RETENTION_DAYS * 86_400_000).toISOString());
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the insert's error is the one to surface */ }
    throw err;
  }
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
