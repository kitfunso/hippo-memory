// Promote to the global store, supersede with a successor, and archive raw memories.

import { ConflictError, NotFoundError } from '../core/api-errors.js';
import { stampOriginProject } from '../store/entry-row.js';
import type { ConnectorEvent } from '../store/port.js';
import { createSuccessor, type Layer, type MemoryEntry } from '../core/memory.js';
import { promoteToGlobal } from '../sharing/global-store.js';
import { loadConfig } from '../core/config.js';
import { andThen, notPorted, onStore } from './on-store.js';
import type { Context, StoreReply } from './types.js';
import { memoryReach } from '../store/tenant-lookup.js';
import { canTouchScope, personalScopeOf } from '../core/recall-scope.js';

/** Copies a local memory into the global store; the inner writeEntry emits 'remember' there, and we add a 'promote' audit event so intent stays distinct.
 * promoteToGlobal reads via `readEntry` with no tenant filter and keeps the entry's existing tenantId on the global side. */
export interface PromoteResult {
  ok: true;
  sourceId: string;
  globalId: string;
}
export function promote(
  ctx: Context,
  id: string,
): PromoteResult {
  // promoteToGlobal reads without a tenant filter, so pre-check the row's tenant_id and deny cross-tenant access with archiveRaw's not-found wording
  // (no leak about whether the id exists in another tenant).
  const reach = memoryReach(ctx.hippoRoot, id);
  if (reach?.tenantId !== ctx.tenantId || !canTouchScope(ctx.actor, reach.scope)) {
    throw new NotFoundError(`memory not found: ${id}`);
  }

  // The 'promote' row commits with the global copy, so no write follows the commit and a busy store fails the whole promote.
  const globalEntry = promoteToGlobal(ctx.hippoRoot, id, {
    actor: ctx.actor.subject,
    tenantId: ctx.tenantId,
    auditAs: { tenantId: ctx.tenantId, actor: ctx.actor.subject },
  });

  return { ok: true, sourceId: id, globalId: globalEntry.id };
}

/** Replace an old memory with new content, chaining old.superseded_by = new.id; the store commits both rows and the audit row together. */
export interface SupersedeResult {
  ok: true;
  oldId: string;
  newId: string;
}
/** What the successor takes instead of the old row's value. Never set from a request body: the CLI fills it from its flags. */
export interface SupersedeOverrides {
  layer?: Layer;
  tags?: string[];
  pinned?: boolean;
}
export function supersede<C extends Context>(
  ctx: C,
  oldId: string,
  newContent: string,
  overrides: SupersedeOverrides = {},
): StoreReply<C, SupersedeResult> {
  return onStore(ctx, (port) => {
    const entryWrites = port.entryWrites ?? notPorted(port, 'entryWrites');
    return andThen(port.entriesByIds([oldId], ctx.tenantId), ([old]) => {
      const newEntry = createSuccessor(assertSupersedable(ctx, oldId, old ?? null), newContent, {
        tenantId: ctx.tenantId,
        baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
        layer: overrides.layer,
        tags: overrides.tags,
        pinned: overrides.pinned,
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

/** Archive a kind='raw' memory: its metadata moves to raw_archive and the row is
 * deleted. The store writes the one archive_raw audit row, under the caller's subject. */
export interface ArchiveRawOpts {
  /** The connector event this archive answers. The store logs it in the archive's own transaction, so a redelivery finds it logged. */
  event?: ConnectorEvent;
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
  return onStore(ctx, (port) => {
    const entryWrites = port.entryWrites ?? notPorted(port, 'entryWrites');
    const archive = { tenantId: ctx.tenantId, actor: ctx.actor.subject, ownScope: personalScopeOf(ctx.actor), id, reason };
    const { event } = opts;
    const archived = event
      ? (port.connectorWrites ?? notPorted(port, 'connectorWrites')).archiveConnectorEntry({ ...archive, event })
      : entryWrites.archiveRaw(archive);
    return andThen(archived, (archivedAt): ArchiveRawResult => ({ ok: true, archivedAt }));
  });
}
