// Where-you-left-off ops: task snapshot, session events, handoffs and working memory.

import type { HandoffOutcome, SessionHandoff } from '../core/handoff.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import {
  appendSessionEvent, clearActiveTaskSnapshot, listSessionEvents, loadActiveTaskSnapshot, saveActiveTaskSnapshot,
} from '../store/sessions.js';
import { loadHandoffById, loadLatestHandoff, saveSessionHandoff, stampHandoffOutcome } from '../store/handoffs.js';
import { wmClear, wmFlush, wmPush, wmRead, type WorkingMemoryItem } from '../store/working-memory.js';
import type { Context } from './types.js';

/** What a snapshot save carries. */
export type SnapshotSaveInput = Parameters<typeof saveActiveTaskSnapshot>[2];

/** What a session event append carries. */
export type SessionEventAppendInput = Parameters<typeof appendSessionEvent>[2];

/** What a session event listing filters on. */
export type SessionEventListOpts = NonNullable<Parameters<typeof listSessionEvents>[2]>;

/** Save the caller's active task snapshot. */
export function snapshotSave(ctx: Context, input: SnapshotSaveInput): TaskSnapshot {
  return saveActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, input);
}

/** Clear the caller's active task snapshot; false when there was none. */
export function snapshotClear(ctx: Context, status: string): boolean {
  return clearActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, status);
}

/** The caller's active task snapshot, or null. */
export function snapshotLoad(ctx: Context): TaskSnapshot | null {
  return loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId);
}

/** Append a session event in the caller's tenant. */
export function sessionEventAppend(ctx: Context, event: SessionEventAppendInput): SessionEvent {
  return appendSessionEvent(ctx.hippoRoot, ctx.tenantId, event);
}

/** List the caller's session events. */
export function sessionEventList(ctx: Context, opts: SessionEventListOpts): SessionEvent[] {
  return listSessionEvents(ctx.hippoRoot, ctx.tenantId, opts);
}

export interface LatestContinuity {
  snapshot: TaskSnapshot | null;
  events: SessionEvent[];
}

/** The active snapshot plus recent events for `sessionId`, falling back to the snapshot's own session. */
export function continuityLatest(ctx: Context, opts: { sessionId?: string; limit: number }): LatestContinuity {
  const snapshot = loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId);
  const events = listSessionEvents(ctx.hippoRoot, ctx.tenantId, {
    session_id: opts.sessionId || snapshot?.session_id || undefined,
    limit: opts.limit,
  });
  return { snapshot, events };
}

/** Stamp the outcome on the caller's handoff for `sessionId`; returns the rows stamped. */
export function handoffStampOutcome(ctx: Context, sessionId: string, outcome: HandoffOutcome): number {
  return stampHandoffOutcome(ctx.hippoRoot, ctx.tenantId, sessionId, outcome);
}

/** Save a session handoff in the caller's tenant. */
export function handoffSave(ctx: Context, handoff: Omit<SessionHandoff, 'updatedAt'>): SessionHandoff {
  return saveSessionHandoff(ctx.hippoRoot, ctx.tenantId, handoff);
}

/** The caller's latest handoff, optionally for one session. */
export function handoffLatest(ctx: Context, sessionId?: string): SessionHandoff | null {
  return loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, sessionId);
}

/** The caller's handoff by id, or null. */
export function handoffById(ctx: Context, id: number): SessionHandoff | null {
  return loadHandoffById(ctx.hippoRoot, ctx.tenantId, id);
}

/** Push a working memory entry in the caller's tenant; returns its row id. */
export function workingMemoryPush(ctx: Context, opts: Omit<Parameters<typeof wmPush>[1], 'tenantId'>): number {
  return wmPush(ctx.hippoRoot, { ...opts, tenantId: ctx.tenantId });
}

/** The caller's working memory entries, most important first. */
export function workingMemoryRead(ctx: Context, opts: Omit<NonNullable<Parameters<typeof wmRead>[1]>, 'tenantId'>): WorkingMemoryItem[] {
  return wmRead(ctx.hippoRoot, { ...opts, tenantId: ctx.tenantId });
}

/** Delete the caller's working memory entries; returns the count. */
export function workingMemoryClear(ctx: Context, opts: Omit<NonNullable<Parameters<typeof wmClear>[1]>, 'tenantId'>): number {
  return wmClear(ctx.hippoRoot, { ...opts, tenantId: ctx.tenantId });
}

/** Flush the caller's working memory at session end; returns the count. */
export function workingMemoryFlush(ctx: Context, opts: Omit<NonNullable<Parameters<typeof wmFlush>[1]>, 'tenantId'>): number {
  return wmFlush(ctx.hippoRoot, { ...opts, tenantId: ctx.tenantId });
}
