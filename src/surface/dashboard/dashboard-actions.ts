// The four dashboard writes, each the api call the CLI makes; the router owns HTTP and the cache.

import * as api from '../../api/index.js';
import { memoryGet } from '../../api/memories/memories.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { RawAppendOnlyError } from '../../base/errors/raw-append-only.js';
import { ParamError, parseMemoryId, type ActionBody } from './dashboard-params.js';
import { isLiveMemory } from '../../api/dashboard/live.js';
import type { ForgetResult, ResolveResult } from '../../api/dashboard/types.js';

/** What an action hands the router: a status, a JSON body, and whether the store changed. */
export interface ActionResult {
  status: number;
  body: unknown;
  /** True when a write committed, so the router moves the snapshot id. */
  changed: boolean;
  /** The live entry an action acted on, so the router can build the detail after the cache is dropped. */
  entry?: MemoryEntry;
}

function notFound(): ActionResult {
  return { status: 404, body: { error: 'Not found' }, changed: false };
}

async function liveEntry(ctx: api.Context, id: string): Promise<MemoryEntry | null> {
  const entry = await memoryGet(ctx, id);
  return entry !== null && isLiveMemory(entry) ? entry : null;
}

/** Sets `pinned`, audited as a pin by the Context's actor. */
export async function pinMemory(ctx: api.Context, rawId: string, body: ActionBody): Promise<ActionResult> {
  const id = parseMemoryId(rawId);
  const { pinned } = body;
  if (pinned === undefined) throw new ParamError('pinned must be true or false');
  if ((await liveEntry(ctx, id)) === null) return notFound();
  try {
    return { status: 200, body: null, changed: true, entry: await api.memoryPin(ctx, id, pinned) };
  } catch (err) {
    if (err instanceof NotFoundError) return notFound();
    throw err;
  }
}

/** Marks a memory wrong, the same signal as `hippo outcome --bad`. */
export async function markWrong(ctx: api.Context, rawId: string): Promise<ActionResult> {
  const id = parseMemoryId(rawId);
  if ((await liveEntry(ctx, id)) === null) return notFound();
  // outcome() answers `applied: 0` for a missing or out-of-reach id instead of throwing.
  if ((await api.outcome(ctx, [id], false)).applied === 0) return notFound();
  const entry = await memoryGet(ctx, id);
  return entry === null ? notFound() : { status: 200, body: null, changed: true, entry };
}

/** Deletes a memory like `hippo forget`; a raw receipt is append-only and answers 409 with the archive hint. */
export async function forgetMemory(ctx: api.Context, rawId: string): Promise<ActionResult> {
  const id = parseMemoryId(rawId);
  if ((await liveEntry(ctx, id)) === null) return notFound();
  try {
    const done: ForgetResult = await api.forget(ctx, id);
    return { status: 200, body: done, changed: true };
  } catch (err) {
    if (err instanceof NotFoundError) return notFound();
    if (err instanceof RawAppendOnlyError) {
      const error = `Cannot forget ${id}: it is a raw, append-only memory. Archive it instead: hippo forget ${id} --archive --reason "<why>"`;
      return { status: 409, body: { error }, changed: false };
    }
    throw err;
  }
}

/** Keeps one side of an open conflict and weakens the other; the api's refusals keep their old statuses and texts. */
export async function resolveOpenConflict(
  ctx: api.Context,
  conflictId: number,
  body: ActionBody,
): Promise<ActionResult> {
  const { keep } = body;
  if (keep === undefined) throw new ParamError('keep must be a memory id');
  parseMemoryId(keep);
  try {
    const { loserId } = await api.conflictResolve(ctx, conflictId, { keepId: keep });
    const result: ResolveResult = { ok: true, conflictId, keptId: keep, weakenedId: loserId };
    return { status: 200, body: result, changed: true };
  } catch (err) {
    // The dashboard acts as an unowned admin, so a pair holding a personal row reads as missing.
    if (err instanceof NotFoundError) return notFound();
    if (err instanceof ConflictError) {
      return { status: 409, body: { error: 'This conflict is already resolved' }, changed: false };
    }
    if (err instanceof BadRequestError) throw new ParamError('keep must be one of the two memories in the conflict');
    throw err;
  }
}
