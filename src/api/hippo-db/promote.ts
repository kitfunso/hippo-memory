// Promote a local memory to the operator's global store, through hippo.db's local tier.

import {
  BadRequestError,
  memoryNotFoundText,
  NotFoundError,
} from '../../base/errors/api-errors.js';
import type { StoreHome } from '../../base/ports/store.js';
import { generateId, type MemoryEntry } from '../../base/memory/entry.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import { embedMemoryDetached, folderEmbedTarget } from '../../domain/search/embed-memories.js';
import { globalTargetOf } from '../infra.js';
import { withDetached } from '../detached.js';
import { sharedStoreOf, type ContextWith } from '../types.js';
import { canReadScope, isPersonalScope, isQuarantineScope } from '../../base/scope/recall-scope.js';

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
    await ctx.store.hippoDb.folderFiles.home(),
    entry,
    sharedStoreOf(ctx),
    ctx.infra.clock(),
  );
  await target.store.hippoDb.promotion.writeCopy(globalEntry, {
    actor: ctx.actor.subject,
    sourceId: id,
    auditAs: { tenantId: ctx.tenantId, actor: ctx.actor.subject },
  });
  // A promote may create the global store, which only the write target names before it exists.
  await withDetached(ctx, (detached) =>
    embedMemoryDetached(folderEmbedTarget(target, ctx.infra), globalEntry, detached),
  );
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
