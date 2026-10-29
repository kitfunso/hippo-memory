// Promote to the global store, supersede with a successor, and archive raw memories.

import {
  BadRequestError,
  ConflictError,
  memoryNotFoundText,
  NotFoundError,
} from '../../base/errors/api-errors.js';
import type { ConnectorEvent, StoreHome } from '../../base/ports/store.js';
import {
  createSuccessor,
  generateId,
  type Layer,
  type MemoryEntry,
} from '../../base/memory/entry.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import { embedMemoryDetached, folderEmbedTarget } from '../../domain/search/embed-memories.js';
import { globalTargetOf } from '../infra.js';
import { sharedStoreOf, type Context, type ContextWith } from '../types.js';
import {
  assertWriteRight,
  canReadScope,
  isPersonalScope,
  isQuarantineScope,
  scopeReaderOf,
} from '../../base/scope/recall-scope.js';

/** Copies a local memory into the global store; the inner writeEntry emits 'remember' there, and
 * we add a 'promote' audit event so intent stays distinct. The copy keeps the entry's tenantId
 * on the global side. */
export interface PromoteResult {
  ok: true;
  sourceId: string;
  globalId: string;
}
export async function promote(ctx: ContextWith<'folderFiles'>, id: string): Promise<PromoteResult> {
  // Another tenant's row and a row out of the caller's reach read alike, so the reply says nothing
  // of either.
  const [entry] = await ctx.store.entriesByIds([id], ctx.tenantId);
  if (!entry || !canReadScope(ctx.actor, entry.scope ?? null)) {
    throw new NotFoundError(memoryNotFoundText(id));
  }
  // A root's reach sets it for a store kept in a folder, so only a context built without a reach
  // lacks it.
  const target = globalTargetOf(ctx);
  if (target === undefined) {
    throw new Error('promote needs ctx.reach.globalTarget, the global store to copy into');
  }
  assertPromotable(id, entry);

  // The 'promote' row commits with the global copy, so no write follows the commit and a busy store
  // fails the whole promote.
  const globalEntry = globalCopyOf(
    await ctx.store.folderFiles.home(),
    entry,
    sharedStoreOf(ctx),
    ctx.infra.clock(),
  );
  await target.store.promotion.writeCopy(globalEntry, {
    actor: ctx.actor.subject,
    sourceId: id,
    auditAs: { tenantId: ctx.tenantId, actor: ctx.actor.subject },
  });
  // A promote may create the global store, which only the write target names before it exists.
  embedMemoryDetached(folderEmbedTarget(target, ctx.infra), globalEntry);
  return { ok: true, sourceId: id, globalId: globalEntry.id };
}

/** The copy of a local memory, with a new `g_` id so it cannot collide. A project store's NULL
 * row gets its folder back; a shared store's folder is no caller's project, so NULL stays and
 * the label names no path. */
function globalCopyOf(
  local: StoreHome,
  entry: MemoryEntry,
  shared: boolean,
  now: Date,
): MemoryEntry {
  return {
    ...entry,
    id: generateId('g'),
    source: shared ? `shared::${now.toISOString()}` : `promoted:${local.folder}`,
    originProject: entry.originProject ?? (shared ? null : local.project.name),
  };
}

function assertPromotable(id: string, entry: MemoryEntry): void {
  // Same quarantine veto as shareMemory; a promoted copy would have no quarantine record to review.
  if (isQuarantineScope(entry.scope)) {
    throw new BadRequestError(
      `Refusing to promote ${id}: it is quarantined pending review. Approve it first via 'hippo quarantine approve ` +
        `${id}'.`,
    );
  }
  if (isPersonalScope(entry.scope ?? null)) {
    throw new BadRequestError(
      `Refusing to promote ${id}: it is a personal memory and stays with its owner on this server.`,
    );
  }

  // Secret producer veto: promote is a producer path to the global store exactly like shareMemory -
  // same hard rule.
  const promoteSecret = detectSecret(entry);
  if (promoteSecret.flagged) {
    throw new BadRequestError(
      `Refusing to promote ${id} to the global store: content matches secret material (${promoteSecret.reason}). ` +
        `Secrets stay in their owning project's store.`,
    );
  }
}

/** Replace an old memory with new content, chaining old.supersededBy = new.id; the store commits
 * both rows and the audit row together. */
export interface SupersedeResult {
  ok: true;
  oldId: string;
  newId: string;
}
/** What the successor takes instead of the old row's value. Never set from a request body: the
 * CLI fills it from its flags. */
export interface SupersedeOverrides {
  layer?: Layer;
  tags?: string[];
  pinned?: boolean;
}
export async function supersede(
  ctx: Context,
  oldId: string,
  newContent: string,
  overrides: SupersedeOverrides = {},
): Promise<SupersedeResult> {
  const store = ctx.store;
  const entryWrites = store.entryWrites;
  const [old] = await store.entriesByIds([oldId], ctx.tenantId);
  const successor = createSuccessor(
    assertSupersedable(ctx, oldId, old ?? null),
    newContent,
    {
      tenantId: ctx.tenantId,
      baseHalfLifeDays: ctx.config.defaultHalfLifeDays,
      layer: overrides.layer,
      tags: overrides.tags,
      pinned: overrides.pinned,
    },
    ctx.infra.clock(),
  );
  await entryWrites.supersede({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    oldId,
    successor,
  });
  return { ok: true, oldId, newId: successor.id };
}

/** The tenant-scoped row to supersede; another tenant's id, or a row out of reach, reads as not
 * found. */
function assertSupersedable(ctx: Context, oldId: string, old: MemoryEntry | null): MemoryEntry {
  const row = old ?? undefined;
  assertWriteRight(scopeReaderOf(ctx.actor), row, oldId, `Memory not found: ${oldId}`);
  // The CAS UPDATE closes the race; this check only gives a clearer error in the common
  // single-writer case.
  if (row.supersededBy) {
    throw new ConflictError(
      `Memory ${oldId} is already superseded by ${row.supersededBy}. Supersede that one instead.`,
    );
  }
  return row;
}

export interface ArchiveRawResult {
  ok: true;
  archivedAt: string;
}

function archiveOf(ctx: Context, id: string, reason: string) {
  return {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    id,
    reason,
  };
}

/** Archive a kind='raw' memory: its metadata moves to raw_archive and the row is deleted. The
 * store writes the one archive_raw audit row, under the caller's subject. */
export async function rawArchive(
  ctx: Context,
  id: string,
  reason: string,
): Promise<ArchiveRawResult> {
  return {
    ok: true,
    archivedAt: await ctx.store.entryWrites.archiveRaw(archiveOf(ctx, id, reason)),
  };
}

/** rawArchive for a connector's delete: the store logs `event` in the archive's own transaction,
 * so a redelivery finds it logged. */
export async function rawArchiveForEvent(
  ctx: ContextWith<'connectorWrites'>,
  id: string,
  reason: string,
  event: ConnectorEvent,
): Promise<ArchiveRawResult> {
  const archivedAt = await ctx.store.hippoDb.connectorWrites.archiveConnectorEntry({
    ...archiveOf(ctx, id, reason),
    event,
  });
  return { ok: true, archivedAt };
}
