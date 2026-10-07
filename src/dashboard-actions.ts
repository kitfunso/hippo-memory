// The four dashboard writes, each a thin call into an existing store or api function; the router owns HTTP and the cache.

import * as api from './api.js';
import { NotFoundError } from './api-errors.js';
import type { MemoryEntry } from './memory.js';
import { listTouchableConflicts, resolveConflict } from './store/conflicts.js';
import { readEntry } from './store/entry-reads.js';
import { writeEntry } from './store/entry-writes.js';
import { ParamError, parseMemoryId, type ActionBody } from './dashboard-params.js';
import { isLiveMemory } from './dashboard-snapshot.js';
import type { ForgetResult, ResolveResult } from './dashboard-types.js';

/** What an action hands the router: a status, a JSON body, and whether the store changed. */
export interface ActionResult {
  status: number;
  body: unknown;
  /** True when a write committed, so the router drops the snapshot. */
  changed: boolean;
  /** The live entry an action acted on, so the router can build the detail after the cache is dropped. */
  entry?: MemoryEntry;
}

const ACTOR = 'dashboard';

function notFound(): ActionResult {
  return { status: 404, body: { error: 'Not found' }, changed: false };
}

function liveEntry(hippoRoot: string, tenantId: string, id: string): MemoryEntry | null {
  const entry = readEntry(hippoRoot, id, tenantId);
  return entry !== null && isLiveMemory(entry) ? entry : null;
}

/** Sets `pinned`; the audit row says `remember` with actor `dashboard`, the same op the old star toggle wrote. */
export function pinMemory(hippoRoot: string, tenantId: string, rawId: string, body: ActionBody): ActionResult {
  const id = parseMemoryId(rawId);
  const { pinned } = body;
  if (pinned === undefined) throw new ParamError('pinned must be true or false');
  const entry = liveEntry(hippoRoot, tenantId, id);
  if (entry === null) return notFound();
  const next = { ...entry, pinned };
  writeEntry(hippoRoot, next, { actor: ACTOR });
  return { status: 200, body: null, changed: true, entry: next };
}

/** Marks a memory wrong, the same signal as `hippo outcome --bad`. */
export function markWrong(hippoRoot: string, tenantId: string, rawId: string): ActionResult {
  const id = parseMemoryId(rawId);
  if (liveEntry(hippoRoot, tenantId, id) === null) return notFound();
  const ctx: api.HippoDbContext = { hippoRoot, tenantId, actor: api.adminActor(ACTOR) };
  // outcome() answers `applied: 0` for a missing or other-tenant id instead of throwing.
  if (api.outcome(ctx, [id], false).applied === 0) return notFound();
  const entry = readEntry(hippoRoot, id, tenantId);
  return entry === null ? notFound() : { status: 200, body: null, changed: true, entry };
}

/** Deletes a memory like `hippo forget`; a raw receipt is append-only and answers 409 with the archive hint. */
export function forgetMemory(hippoRoot: string, tenantId: string, rawId: string): ActionResult {
  const id = parseMemoryId(rawId);
  if (liveEntry(hippoRoot, tenantId, id) === null) return notFound();
  const ctx: api.HippoDbContext = { hippoRoot, tenantId, actor: api.adminActor(ACTOR) };
  try {
    const done: ForgetResult = api.forget(ctx, id);
    return { status: 200, body: done, changed: true };
  } catch (err) {
    if (err instanceof NotFoundError) return notFound();
    // Same match as cmdForget: the append-only trigger names itself in the message.
    if (err instanceof Error && /append-only/i.test(err.message)) {
      const error = `Cannot forget ${id}: it is a raw, append-only memory. Archive it instead: hippo forget ${id} --archive --reason "<why>"`;
      return { status: 409, body: { error }, changed: false };
    }
    throw err;
  }
}

/** Keeps one side of an open conflict and weakens the other; every refusal maps to its own status. */
export function resolveOpenConflict(hippoRoot: string, tenantId: string, conflictId: number, body: ActionBody): ActionResult {
  const { keep } = body;
  if (keep === undefined) throw new ParamError('keep must be a memory id');
  parseMemoryId(keep);
  // The dashboard acts as an unowned admin, so a pair holding a personal row reads as missing, open or resolved.
  const conflict = listTouchableConflicts(hippoRoot, '*', tenantId, api.adminActor(ACTOR)).find((c) => c.id === conflictId);
  if (!conflict) return notFound();
  const already = (): ActionResult => ({ status: 409, body: { error: 'This conflict is already resolved' }, changed: false });
  if (conflict.status !== 'open') return already();
  if (keep !== conflict.memory_a_id && keep !== conflict.memory_b_id) {
    throw new ParamError('keep must be one of the two memories in the conflict');
  }
  if (liveEntry(hippoRoot, tenantId, conflict.memory_a_id) === null || liveEntry(hippoRoot, tenantId, conflict.memory_b_id) === null) {
    return notFound();
  }
  const resolved = resolveConflict(hippoRoot, conflictId, keep, false, tenantId, { rejectedBy: ACTOR });
  // Both guards passed above, so null here is a race with another resolver.
  if (resolved === null) return already();
  const result: ResolveResult = { ok: true, conflictId, keptId: keep, weakenedId: resolved.loserId };
  return { status: 200, body: result, changed: true };
}
