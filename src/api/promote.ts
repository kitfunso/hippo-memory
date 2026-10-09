// Promote to the global store, supersede with a successor, and archive raw memories.

import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { ConflictError, NotFoundError } from '../api-errors.js';
import { stampOriginProject } from '../store/entry-row.js';
import { createSuccessor, type MemoryEntry } from '../memory.js';
import { appendAuditEvent } from '../audit.js';
import { promoteToGlobal } from '../shared.js';
import { loadConfig } from '../config.js';
import { andThen, notPorted, onStore } from './on-store.js';
import type { Context, StoreReply } from './types.js';
import { selectMemoryReach } from '../store/tenant-lookup.js';
import { canTouchScope, personalScopeOf } from '../recall-scope.js';

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
    const reach = selectMemoryReach(ownerDb, id);
    if (reach?.tenantId !== ctx.tenantId || !canTouchScope(ctx.actor, reach.scope)) {
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
export function supersede<C extends Context>(
  ctx: C,
  oldId: string,
  newContent: string,
): StoreReply<C, SupersedeResult> {
  return onStore(ctx, (port) => {
    const entryWrites = port.entryWrites ?? notPorted(port, 'entryWrites');
    return andThen(port.entriesByIds([oldId], ctx.tenantId), ([old]) => {
      const newEntry = createSuccessor(assertSupersedable(ctx, oldId, old ?? null), newContent, {
        tenantId: ctx.tenantId,
        baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
      });
      // A store writes origin_project as given, so the served folder's fallback is stamped here.
      const successor = stampOriginProject(ctx.hippoRoot, newEntry);
      const write = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), oldId, successor };
      return andThen(entryWrites.supersede(write), (): SupersedeResult => ({ ok: true, oldId, newId: successor.id }));
    });
  });
}

/** The tenant-scoped row to supersede; another tenant's id, or someone else's personal row, reads as not found. */
function assertSupersedable(ctx: Context, oldId: string, old: MemoryEntry | null): MemoryEntry {
  if (!old || !canTouchScope(ctx.actor, old.scope ?? null)) {
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

// ---------------------------------------------------------------------------
// archive_raw
// ---------------------------------------------------------------------------

/** Archive a kind='raw' memory: its metadata moves to raw_archive and the row is deleted. The store writes the one archive_raw audit row, under the caller's subject. */
export interface ArchiveRawOpts {
  /** A connector's idempotency hook. It runs inside the archive's write scope on hippo.db's own handle, so a throw undoes the archive; a served store refuses it. */
  afterArchive?: (db: DatabaseSyncLike, archivedMemoryId: string) => void;
}

export interface ArchiveRawResult {
  ok: true;
  archivedAt: string;
}
export function archiveRaw<C extends Context>(
  ctx: C,
  id: string,
  reason: string,
  opts: ArchiveRawOpts = {},
): StoreReply<C, ArchiveRawResult> {
  return onStore(ctx, (port, local) => {
    const entryWrites = port.entryWrites ?? notPorted(port, 'entryWrites');
    const archive = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), id, reason };
    const { afterArchive } = opts;
    const archived = afterArchive ? local.archiveRaw(archive, afterArchive) : entryWrites.archiveRaw(archive);
    return andThen(archived, (archivedAt): ArchiveRawResult => ({ ok: true, archivedAt }));
  });
}
