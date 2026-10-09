// A session id belongs to the first owner that binds it, so one developer's client cannot write into another's session.
import { ConflictError } from './api-errors.js';
import { ownerOrSubject, type Context, type StoreReply } from './api/types.js';
import { closeHippoDb, execWithBusyRetry, HOOK_DB_WAIT_MS, openHippoDb, scopedBusyWait, type DatabaseSyncLike } from './db.js';
import { raiseMinBinary } from './db/meta.js';
import { requireGroup, type HippoStore, type SessionBinding } from './store-port.js';
import { assertTenantId } from './tenant.js';
import { TASK_OWNER_MIN_BINARY } from './version.js';

/** Bindings older than this are pruned when a new session binds. */
export const BINDING_RETENTION_DAYS = 90;

function boundOwner(db: DatabaseSyncLike, tenantId: string, sessionId: string): string | null {
  // SAFETY: the SELECT names exactly this one TEXT column.
  const row = db.prepare(`SELECT owner_subject FROM session_owners WHERE tenant_id = ? AND session_id = ?`).get(tenantId, sessionId) as { owner_subject: string } | undefined;
  return row?.owner_subject ?? null;
}

/** Binds under the write lock and returns the stored owner, which is not `owner` when a concurrent first bind won. */
export function insertBinding(db: DatabaseSyncLike, tenantId: string, sessionId: string, owner: string): string | null {
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

/** The stored owner, binding `owner` first when none is stored. */
export function boundOrBind(db: DatabaseSyncLike, tenantId: string, sessionId: string, owner: string): string | null {
  // A bound session is the common case after the first prompt, so it must not take the write lock.
  return boundOwner(db, tenantId, sessionId) ?? insertBinding(db, tenantId, sessionId, owner);
}

/** Binds `sessionId` to the caller's owner on first use; a session another owner holds is a 409, so the client can set it aside. */
export function bindSessionOwner<C extends Context>(ctx: C, sessionId: string): StoreReply<C, void> {
  const reply = ctx.store ? bindThroughStore(ctx.store, ctx, sessionId) : bindOnHippoDb(ctx, sessionId);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, void>;
}

function sessionBinding(ctx: Context, sessionId: string): SessionBinding {
  assertTenantId('bindSessionOwner', ctx.tenantId);
  return { tenantId: ctx.tenantId, sessionId, owner: ownerOrSubject(ctx.actor) };
}

async function bindThroughStore(store: HippoStore, ctx: Context, sessionId: string): Promise<void> {
  const hooks = requireGroup(store, 'hooks');
  const binding = sessionBinding(ctx, sessionId);
  assertOwner(await hooks.bindSession(binding), binding.owner);
}

function bindOnHippoDb(ctx: Context, sessionId: string): void {
  const { tenantId, owner } = sessionBinding(ctx, sessionId);
  const db = openHippoDb(ctx.hippoRoot);
  try {
    assertOwner(boundOrBind(db, tenantId, sessionId, owner), owner);
  } finally {
    closeHippoDb(db);
  }
}

function assertOwner(bound: string | null, owner: string): void {
  if (bound !== owner) throw new ConflictError('session id belongs to another caller');
}
