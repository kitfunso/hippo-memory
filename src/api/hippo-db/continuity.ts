// The operator's where-you-left-off on hippo.db's local tier: snapshot, session events, handoffs
// and working memory, each in the caller's tenant and unkeyed, since the operator owns every key.

import type {
  SessionEvent,
  SessionEventInput,
  SessionEventQuery,
  SnapshotInput,
  TaskSnapshot,
  WorkingMemoryFilter,
  WorkingMemoryItem,
  WorkingMemoryPush,
} from '../../base/records/sessions.js';
import type { HandoffOutcome, SessionHandoff } from '../../base/session/handoff.js';
import type { JsonObject } from '../../base/util/json.js';
import type { HippoDbContext } from '../hippo-db-context.js';

export interface LatestContinuity {
  snapshot: TaskSnapshot | null;
  events: SessionEvent[];
}

/** The active snapshot plus recent events for `sessionId`, falling back to the snapshot's
 * own session. */
export async function continuityLatest(
  ctx: HippoDbContext,
  opts: { sessionId?: string; limit: number },
): Promise<LatestContinuity> {
  const { sessions } = ctx.store.hippoDb;
  const snapshot = await sessions.loadSnapshot(ctx.tenantId, {}, null);
  const events = await sessions.read(ctx.tenantId, 'event', {
    sessionId: opts.sessionId || snapshot?.sessionId || undefined,
    limit: opts.limit,
  });
  return { snapshot, events };
}

/** Supersedes the tenant's earlier active snapshots. */
export function saveSnapshot(ctx: HippoDbContext, snapshot: SnapshotInput): Promise<TaskSnapshot> {
  return ctx.store.hippoDb.sessions.save(ctx.tenantId, 'snapshot', snapshot, null);
}

/** Closes the tenant's newest active snapshot with `status`, whoever saved it; rows closed. */
export function clearSnapshot(ctx: HippoDbContext, status: string): Promise<number> {
  return ctx.store.hippoDb.sessions.clear(ctx.tenantId, 'snapshot', { status });
}

export function activeSnapshot(ctx: HippoDbContext): Promise<TaskSnapshot | null> {
  return ctx.store.hippoDb.sessions.loadSnapshot(ctx.tenantId, {}, null);
}

export function logSessionEvent(
  ctx: HippoDbContext,
  event: SessionEventInput,
): Promise<SessionEvent> {
  return ctx.store.hippoDb.sessions.save(ctx.tenantId, 'event', event);
}

/** The newest events the query narrows, oldest first. */
export function sessionEvents(
  ctx: HippoDbContext,
  query: SessionEventQuery,
): Promise<SessionEvent[]> {
  return ctx.store.hippoDb.sessions.read(ctx.tenantId, 'event', query);
}

export interface SessionCompletion {
  readonly sessionId: string;
  readonly task: string | null;
  readonly outcome: HandoffOutcome;
  readonly summary?: string;
  readonly source: string;
}

/** Logs the session's end with its outcome, then stamps that outcome on the session's newest
 * handoff while it has none; `stamped` counts the handoffs stamped. */
export async function completeSession(
  ctx: HippoDbContext,
  { sessionId, task, outcome, summary, source }: SessionCompletion,
): Promise<{ event: SessionEvent; stamped: number }> {
  const { sessions } = ctx.store.hippoDb;
  const metadata: JsonObject = { ended_at: ctx.infra.clock().toISOString() };
  if (summary) metadata.summary = summary;
  const event = await sessions.save(ctx.tenantId, 'event', {
    sessionId,
    task,
    eventType: 'session_complete',
    content: outcome,
    source,
    metadata,
  });
  const stamped = await sessions.save(ctx.tenantId, 'handoff', { sessionId, outcome });
  return { event, stamped };
}

/** Adds the handoff as its session's newest revision. */
export function saveHandoff(
  ctx: HippoDbContext,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
): Promise<SessionHandoff> {
  return ctx.store.hippoDb.sessions.save(ctx.tenantId, 'handoff', { handoff }, null);
}

/** The newest handoff of `sessionId`, or of any session when it is null. */
export function latestHandoff(
  ctx: HippoDbContext,
  sessionId: string | null,
): Promise<SessionHandoff | null> {
  return ctx.store.hippoDb.sessions.read(ctx.tenantId, 'handoff', { sessionId }, null);
}

export function handoffById(ctx: HippoDbContext, id: number): Promise<SessionHandoff | null> {
  return ctx.store.hippoDb.sessions.read(ctx.tenantId, 'handoff', { id });
}

/** The new item's id. */
export function pushWorkingMemory(ctx: HippoDbContext, item: WorkingMemoryPush): Promise<number> {
  return ctx.store.hippoDb.sessions.save(ctx.tenantId, 'working_memory', item);
}

export function workingMemory(
  ctx: HippoDbContext,
  query: WorkingMemoryFilter & { readonly limit?: number },
): Promise<WorkingMemoryItem[]> {
  return ctx.store.hippoDb.sessions.read(ctx.tenantId, 'working_memory', query);
}

/** Rows cleared. */
export function clearWorkingMemory(
  ctx: HippoDbContext,
  filter: WorkingMemoryFilter,
): Promise<number> {
  return ctx.store.hippoDb.sessions.clear(ctx.tenantId, 'working_memory', filter);
}
