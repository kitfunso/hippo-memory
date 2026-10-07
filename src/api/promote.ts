// Promote to the global store, supersede with a successor, and archive raw memories.

import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { ConflictError, NotFoundError } from '../api-errors.js';
import { stampOriginProject } from '../store/entry-row.js';
import { writeEntryMirrors } from '../store/entry-writes.js';
import { cleanArchivedMirrors, commitSupersede } from '../store/entry-writes-group.js';
import { readEntry } from '../store/entry-reads.js';
import { updateStatsUnlessBusy } from '../store/index-and-stats.js';
import { requireGroup, type HippoStore } from '../store-port.js';
import { log } from '../log.js';
import { createSuccessor, type MemoryEntry } from '../memory.js';
import { appendAuditEvent } from '../audit.js';
import { promoteToGlobal } from '../shared.js';
import { archiveRawMemory } from '../raw-archive.js';
import { loadConfig } from '../config.js';
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
  const reply = ctx.store ? supersedeThroughStore(ctx, ctx.store, oldId, newContent) : supersedeOnHippoDb(ctx, oldId, newContent);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, SupersedeResult>;
}

async function supersedeThroughStore(ctx: Context, store: HippoStore, oldId: string, newContent: string): Promise<SupersedeResult> {
  const entryWrites = requireGroup(store, 'entryWrites');
  const [old] = await store.entriesByIds([oldId], ctx.tenantId);
  const newEntry = createSuccessor(assertSupersedable(ctx, oldId, old ?? null), newContent, {
    tenantId: ctx.tenantId,
    baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
  });
  // The store writes origin_project as given, so the served folder's fallback is stamped here.
  const successor = stampOriginProject(ctx.hippoRoot, newEntry);
  await entryWrites.supersede({ tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), oldId, successor });
  return { ok: true, oldId, newId: successor.id };
}

function supersedeOnHippoDb(ctx: Context, oldId: string, newContent: string): SupersedeResult {
  const old = assertSupersedable(ctx, oldId, readEntry(ctx.hippoRoot, oldId, ctx.tenantId));

  const successor = stampOriginProject(ctx.hippoRoot, createSuccessor(old, newContent, {
    tenantId: ctx.tenantId,
    baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
  }));

  // Race-safe transition: open a fresh db handle, BEGIN IMMEDIATE, run all
  // three steps (CAS on old + writeEntryDbOnly(new) + supersede audit row)
  // inside the same transaction. Two concurrent supersedes: exactly one CAS
  // wins (changes=1), the other gets changes=0 and throws CONFLICT. No
  // dangling-pointer window: the new memory's row commits atomically with
  // the old.superseded_by pointer.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    commitSupersede(db, { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), oldId, successor });
    // Mirrors after COMMIT, while the db handle is still open. Same
    // invariant as the original writeEntry: a mirror failure leaves disk
    // MISSING the markdown for the new memory (rebuildIndex rewrites every
    // markdown mirror from the DB) but DOES NOT desync the DB or
    // roll back the supersede. Logged + swallowed, non-fatal.
    try {
      writeEntryMirrors(ctx.hippoRoot, successor);
    } catch (mirrorErr) {
      log.error(`supersede: mirror write failed (non-fatal, will self-heal): ${mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)}`);
    }
  } finally {
    closeHippoDb(db);
  }

  return { ok: true, oldId, newId: successor.id };
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
export function archiveRaw<C extends Context>(
  ctx: C,
  id: string,
  reason: string,
  opts: ArchiveRawOpts = {},
): StoreReply<C, ArchiveRawResult> {
  const reply = ctx.store ? archiveRawThroughStore(ctx, ctx.store, id, reason, opts) : archiveRawOnHippoDb(ctx, id, reason, opts);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, ArchiveRawResult>;
}

/** afterArchive writes on hippo.db's own handle, and only connectors send it, so a store refuses it. */
async function archiveRawThroughStore(ctx: Context, store: HippoStore, id: string, reason: string, opts: ArchiveRawOpts): Promise<ArchiveRawResult> {
  const entryWrites = requireGroup(store, 'entryWrites');
  if (opts.afterArchive) throw new Error('afterArchive runs on hippo.db only, never through a store');
  const archivedAt = await entryWrites.archiveRaw({ tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), id, reason });
  return { ok: true, archivedAt };
}

function archiveRawOnHippoDb(ctx: Context, id: string, reason: string, opts: ArchiveRawOpts): ArchiveRawResult {
  const db = openHippoDb(ctx.hippoRoot);
  let archivedAt: string;
  try {
    // Tenant scope: archiveRawMemory looks up the row by id alone, so a
    // Bearer for tenant A could archive tenant B's raw row without this
    // pre-check. Deny cross-tenant access with the same not-found message
    // archiveRawMemory itself would throw on a missing row, so we don't
    // leak whether the id exists in another tenant.
    const reach = selectMemoryReach(db, id);
    if (reach?.tenantId !== ctx.tenantId || !canTouchScope(ctx.actor, reach.scope)) {
      throw new NotFoundError(`memory not found: ${id}`);
    }
    archivedAt = archiveRawMemory(db, id, {
      reason,
      who: ctx.actor.subject,
      afterArchive: opts.afterArchive,
    });
    cleanArchivedMirrors(db, ctx.hippoRoot, id);
  } finally {
    closeHippoDb(db);
  }
  // Counted here rather than in the CLI: the HTTP archive route calls this too,
  // so a routed archive would otherwise never reach the forgotten counter.
  updateStatsUnlessBusy(ctx.hippoRoot, { forgotten: 1 }, `removed ${id}`);
  return { ok: true, archivedAt };
}
