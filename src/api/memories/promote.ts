// Promote to the global store, supersede with a successor, and archive raw memories.

import { BadRequestError, ConflictError, NotFoundError } from '../../core/api-errors.js';
import type { ConnectorEvent, FolderStore } from '../../store/port.js';
import { createSuccessor, generateId, type Layer, type MemoryEntry } from '../../core/memory.js';
import { isSharedStore } from '../../core/config.js';
import { fallbackOrigin } from '../../core/project-identity.js';
import { detectSecret } from '../../util/secret-detect.js';
import { embedMemory, folderIndex } from '../../search/embed-memories.js';
import { configOf } from '../config-of.js';
import type { Context, ContextWith } from '../types.js';
import { canTouchScope, isPersonalScope, isQuarantineScope, personalScopeOf } from '../../core/recall-scope.js';

/** Copies a local memory into the global store; the inner writeEntry emits 'remember' there, and we add a 'promote'
 * audit event so intent stays distinct. The copy keeps the entry's tenantId on the global side. */
export interface PromoteResult {
  ok: true;
  sourceId: string;
  globalId: string;
}
export function promote(
  ctx: ContextWith<'localFiles'>,
  id: string,
): PromoteResult {
  // Pre-check the row's tenant_id and deny cross-tenant access with archiveRaw's not-found wording (no leak about
  // whether the id exists in another tenant).
  const reach = ctx.store.localFiles.promotion.reach(id);
  if (reach?.tenantId !== ctx.tenantId || !canTouchScope(ctx.actor, reach.scope)) {
    throw new NotFoundError(`memory not found: ${id}`);
  }
  // sqliteReach sets it beside hippo.db's files, so only a context built without a reach lacks it.
  const target = ctx.reach?.globalTarget;
  if (target === undefined) throw new Error('promote needs ctx.reach.globalTarget, the global store to copy into');

  // The 'promote' row commits with the global copy, so no write
  // follows the commit and a busy store fails the whole promote.
  const globalEntry = copyToGlobal({ root: ctx.hippoRoot, store: ctx.store }, target, id, {
    actor: ctx.actor.subject,
    tenantId: ctx.tenantId,
    auditAs: { tenantId: ctx.tenantId, actor: ctx.actor.subject },
  });
  // A promote may create the global store, which only the write target names before it exists; this never rejects.
  void embedMemory(folderIndex(target), globalEntry);
  return { ok: true, sourceId: id, globalId: globalEntry.id };
}

interface PromoteOptions {
  readonly actor: string;
  readonly tenantId: string;
  readonly auditAs: { readonly tenantId: string; readonly actor: string };
}

/** Copies a local memory to the global store and returns the copy, which gets a new `g_` id so it cannot collide;
 * the caller embeds it. */
function copyToGlobal(local: FolderStore, global: FolderStore, id: string, opts: PromoteOptions): MemoryEntry {
  const entry = local.store.localFiles.learning.readEntry(id, opts.tenantId);
  if (!entry) throw new NotFoundError(`Memory not found: ${id}`);
  assertPromotable(id, entry);

  // A project store's NULL row gets its folder back; a shared store's folder is no caller's project, so NULL stays and
  // the label names no path.
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: isSharedStore(local.root) ? `shared::${new Date().toISOString()}` : `promoted:${local.root}`,
    origin_project: entry.origin_project ?? fallbackOrigin(local.root),
  };
  const to = global.store.localFiles;
  to.ensureFiles();
  to.promotion.writeCopy(globalEntry, { actor: opts.actor, sourceId: id, auditAs: opts.auditAs });
  return globalEntry;
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

  // Secret producer veto: promote is a producer path to the global store
  // exactly like shareMemory - same hard rule.
  const promoteSecret = detectSecret(entry);
  if (promoteSecret.flagged) {
    throw new BadRequestError(
      `Refusing to promote ${id} to the global store: content matches secret material (${promoteSecret.reason}). ` +
      `Secrets stay in their owning project's store.`,
    );
  }
}

/** Replace an old memory with new content, chaining old.superseded_by = new.id; the store commits both rows and the
 * audit row together. */
export interface SupersedeResult {
  ok: true;
  oldId: string;
  newId: string;
}
/** What the successor takes instead of the old row's value. Never
 * set from a request body: the CLI fills it from its flags. */
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
  const successor = createSuccessor(assertSupersedable(ctx, oldId, old ?? null), newContent, {
    tenantId: ctx.tenantId,
    baseHalfLifeDays: configOf(ctx).defaultHalfLifeDays,
    layer: overrides.layer,
    tags: overrides.tags,
    pinned: overrides.pinned,
  });
  await entryWrites.supersede({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ownScope: personalScopeOf(ctx.actor),
    oldId,
    successor,
  });
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

/** Archive a kind='raw' memory: its metadata moves to raw_archive and the row is
 * deleted. The store writes the one archive_raw audit row, under the caller's subject. */
export interface ArchiveRawOptions {
  /** The connector event this archive answers. The store logs it in the archive's own transaction, so a redelivery
   * finds it logged. */
  event?: ConnectorEvent;
}

export interface ArchiveRawResult {
  ok: true;
  archivedAt: string;
}
export async function archiveRaw(
  ctx: Context,
  id: string,
  reason: string,
  opts: ArchiveRawOptions = {},
): Promise<ArchiveRawResult> {
  const store = ctx.store;
  const entryWrites = store.entryWrites;
  const archive = {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ownScope: personalScopeOf(ctx.actor),
    id,
    reason,
  };
  const { event } = opts;
  const archivedAt = event
    ? await store.connectorWrites.archiveConnectorEntry({ ...archive, event })
    : await entryWrites.archiveRaw(archive);
  return { ok: true, archivedAt };
}
