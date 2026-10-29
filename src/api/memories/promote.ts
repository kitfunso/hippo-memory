// Supersede with a successor, and archive raw memories.

import { ConflictError } from '../../base/errors/api-errors.js';
import { createSuccessor, type Layer, type MemoryEntry } from '../../base/memory/entry.js';
import type { RawArchive } from '../../base/ports/store.js';
import type { Context } from '../types.js';
import { assertWriteRight, scopeReaderOf } from '../../base/scope/recall-scope.js';

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

/** The archive request for `id`, as the caller. */
export function archiveOf(ctx: Context, id: string, reason: string): RawArchive {
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
