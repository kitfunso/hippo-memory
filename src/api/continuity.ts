// Where-you-left-off ops: task snapshot, session events, handoffs and working memory.

import type { HandoffOutcome, SessionHandoff } from '../core/handoff.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import type { SessionEventInput, SnapshotInput } from '../store/sessions.js';
import type { Sessions } from '../store/index.js';
import type { WorkingMemoryItem } from '../store/working-memory.js';
import type { ContextWith } from './types.js';

type Ctx = ContextWith<'sessions'>;

/** What a snapshot save carries. */
export type SnapshotSaveInput = SnapshotInput;

/** What a session event append carries. */
export type SessionEventAppendInput = SessionEventInput;

/** What a session event listing filters on. */
export type SessionEventListOpts = Parameters<Sessions['listEvents']>[1];

/** Save the caller's active task snapshot. */
export function snapshotSave(ctx: Ctx, input: SnapshotSaveInput): Promise<TaskSnapshot> {
  return ctx.store.sessions.saveSnapshot(ctx.tenantId, input, null);
}

/** Clear the caller's active task snapshot; false when there was none. */
export function snapshotClear(ctx: Ctx, status: string): Promise<boolean> {
  return ctx.store.sessions.clearSnapshot(ctx.tenantId, status);
}

/** The caller's active task snapshot, or null. */
export function snapshotLoad(ctx: Ctx): Promise<TaskSnapshot | null> {
  return ctx.store.sessions.loadSnapshot(ctx.tenantId, null);
}

/** Append a session event in the caller's tenant. */
export function sessionEventAppend(ctx: Ctx, event: SessionEventAppendInput): Promise<SessionEvent> {
  return ctx.store.sessions.appendEvent(ctx.tenantId, event);
}

/** List the caller's session events. */
export function sessionEventList(ctx: Ctx, opts: SessionEventListOpts): Promise<SessionEvent[]> {
  return ctx.store.sessions.listEvents(ctx.tenantId, opts);
}

export interface LatestContinuity {
  snapshot: TaskSnapshot | null;
  events: SessionEvent[];
}

/** The active snapshot plus recent events for `sessionId`, falling back to the snapshot's own session. */
export async function continuityLatest(
  ctx: Ctx,
  opts: { sessionId?: string; limit: number },
): Promise<LatestContinuity> {
  const { sessions } = ctx.store;
  const snapshot = await sessions.loadSnapshot(ctx.tenantId, null);
  const events = await sessions.listEvents(ctx.tenantId, {
    sessionId: opts.sessionId || snapshot?.session_id || undefined,
    limit: opts.limit,
  });
  return { snapshot, events };
}

/** Stamp the outcome on the caller's handoff for `sessionId`; returns the rows stamped. */
export function handoffStampOutcome(ctx: Ctx, sessionId: string, outcome: HandoffOutcome): Promise<number> {
  return ctx.store.sessions.stampHandoffOutcome(ctx.tenantId, sessionId, outcome);
}

/** Save a session handoff in the caller's tenant. */
export function handoffSave(ctx: Ctx, handoff: Omit<SessionHandoff, 'updatedAt'>): Promise<SessionHandoff> {
  return ctx.store.sessions.saveHandoff(ctx.tenantId, handoff, null);
}

/** The caller's latest handoff, optionally for one session. */
export function handoffLatest(ctx: Ctx, sessionId?: string): Promise<SessionHandoff | null> {
  return ctx.store.sessions.latestHandoff(ctx.tenantId, sessionId ?? null, {}, null);
}

/** The caller's handoff by id, or null. */
export function handoffById(ctx: Ctx, id: number): Promise<SessionHandoff | null> {
  return ctx.store.sessions.handoffById(ctx.tenantId, id);
}

/** Push a working memory entry in the caller's tenant; returns its row id. */
export function workingMemoryPush(ctx: Ctx, opts: Parameters<Sessions['pushWorkingMemory']>[1]): Promise<number> {
  return ctx.store.sessions.pushWorkingMemory(ctx.tenantId, opts);
}

/** The caller's working memory entries, most important first. */
export function workingMemoryRead(
  ctx: Ctx,
  opts: Parameters<Sessions['readWorkingMemory']>[1],
): Promise<WorkingMemoryItem[]> {
  return ctx.store.sessions.readWorkingMemory(ctx.tenantId, opts);
}

/** Delete the caller's working memory entries; returns the count. */
export function workingMemoryClear(ctx: Ctx, opts: Parameters<Sessions['clearWorkingMemory']>[1]): Promise<number> {
  return ctx.store.sessions.clearWorkingMemory(ctx.tenantId, opts);
}

/** Flush the caller's working memory at session end; returns the count. */
export function workingMemoryFlush(ctx: Ctx, opts: Parameters<Sessions['clearWorkingMemory']>[1]): Promise<number> {
  return ctx.store.sessions.clearWorkingMemory(ctx.tenantId, opts);
}
