// Forget a memory, or name the row a forget would remove.

import { memoryNotFoundText, NotFoundError } from '../../base/errors/api-errors.js';
import { rawRemovalRefusal } from '../../base/errors/raw-append-only.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { Context } from '../types.js';
import { memoryGet } from './memories.js';
import { scopeReaderOf } from '../../base/scope/recall-scope.js';

/** Delete a memory by id. Write rights are checked inside the delete's write scope: a row out of
 * reach answers as not found, and a reached row the caller may not change answers 403. */
export interface ForgetResult {
  ok: true;
  id: string;
}
export async function forget(ctx: Context, id: string): Promise<ForgetResult> {
  const entryWrites = ctx.store.entryWrites;
  await entryWrites.forget({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    id,
  });
  return { ok: true, id };
}

/** The row `forget`, or with `archive` `rawArchive`, would remove now; throws the refusal that
 * call would throw. Reads only. */
export async function removalTarget(
  ctx: Context,
  id: string,
  archive: boolean,
): Promise<MemoryEntry> {
  const entry = await memoryGet(ctx, id);
  if (entry === null) throw new NotFoundError(memoryNotFoundText(id));
  const refusal = rawRemovalRefusal(entry, archive);
  if (refusal !== null) throw refusal;
  return entry;
}
