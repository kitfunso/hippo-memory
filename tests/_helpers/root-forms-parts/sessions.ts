// Root-keyed sessions forms tests call; production code goes through the store port or the At forms.

import type { HandoffOutcome, SessionHandoff } from '../../../src/base/session/handoff.js';
import { sqliteSyncStore } from '../../../src/store/sqlite/store.js';
import { handlesOf } from '../../../src/store/sqlite/handles.js';
import { resolveTenantId } from '../../../src/surface/server/boot.js';
import type {
  HandoffFilter,
  SessionEndHandoffRequest,
  SessionEvent,
  TaskSnapshot,
  WorkingMemoryItem,
} from '../../../src/store/port/sessions.js';
import {
  loadHandoffByIdAt,
  loadLatestHandoffAt,
  stampHandoffOutcomeAt,
  writeSessionEndHandoffAt,
} from '../../../src/store/sqlite/handoffs.js';
import {
  appendConsolidationRunAt,
  loadSessionDecayContextAt,
  saveIndexAt,
  updateStatsUnlessBusyAt,
  updateStatsAt,
} from '../../../src/store/sqlite/index-and-stats.js';
import { readLastRecall } from '../../../src/store/sqlite/mirrors.js';
import { onHandle, openStore } from '../../../src/store/sqlite/handles.js';
import type { HippoIndex } from '../../../src/store/sqlite/rows.js';
import { findPromotableSessionsAt, listSessionEventsAt } from '../../../src/store/sqlite/sessions.js';
import { loadActiveTaskSnapshotAt } from '../../../src/store/sqlite/task-snapshots.js';
import { freshActiveSnapshot } from '../../../src/base/session/session-snapshot.js';
import type { ContinuityKey } from '../../../src/store/port/types.js';
import type { JsonObject } from '../../../src/base/util/json.js';
import type { SessionDecayContext } from '../../../src/store/port/consolidation.js';

export function loadLatestHandoff(
  hippoRoot: string,
  tenantId: string,
  sessionId?: string,
  opts: HandoffFilter = {},
  key?: ContinuityKey,
): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => loadLatestHandoffAt(db, tenantId, sessionId, opts, key), openStore);
}

export function loadHandoffById(hippoRoot: string, tenantId: string, id: number): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => loadHandoffByIdAt(db, tenantId, id), openStore);
}

export function stampHandoffOutcome(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  outcome: HandoffOutcome,
): number {
  return onHandle(hippoRoot, (db) => stampHandoffOutcomeAt(db, tenantId, sessionId, outcome), openStore);
}

export function writeSessionEndHandoff(hippoRoot: string, request: SessionEndHandoffRequest): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => writeSessionEndHandoffAt(db, { hippoRoot }, request.tenantId, request), openStore);
}

export function loadLastRecall(hippoRoot: string): Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'> {
  return onHandle(hippoRoot, (db) => readLastRecall(db), openStore);
}

export function saveIndex(hippoRoot: string, index: Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'>): void {
  return onHandle(hippoRoot, (db) => saveIndexAt(db, index), openStore);
}

export function updateStatsUnlessBusy(
  hippoRoot: string,
  delta: Parameters<typeof updateStatsUnlessBusyAt>[2],
  committed: string,
): void {
  onHandle(hippoRoot, (db) => updateStatsUnlessBusyAt(db, { hippoRoot }, delta, committed), openStore);
}

export function appendConsolidationRun(
  hippoRoot: string,
  run: { timestamp: string; decayed: number; merged: number; removed: number },
): void {
  onHandle(hippoRoot, (db) => appendConsolidationRunAt(db, { hippoRoot }, run), openStore);
}

export function loadSessionDecayContext(hippoRoot: string): SessionDecayContext {
  return onHandle(hippoRoot, (db) => loadSessionDecayContextAt(db), openStore);
}

export function loadActiveTaskSnapshot(hippoRoot: string, tenantId: string, key?: ContinuityKey): TaskSnapshot | null {
  return onHandle(hippoRoot, (db) => loadActiveTaskSnapshotAt(db, { hippoRoot }, tenantId, key), openStore);
}

export function loadFreshActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  opts: { maxAgeMs?: number; sessionId?: string | null } = {},
  key?: ContinuityKey,
): TaskSnapshot | null {
  return freshActiveSnapshot(loadActiveTaskSnapshot(hippoRoot, tenantId, key), opts);
}

export function clearActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  clearedStatus: string = 'cleared',
): boolean {
  return sqliteSyncStore(handlesOf(hippoRoot)).sessions.clearSnapshot(tenantId, clearedStatus);
}

export function closeTaskSnapshotsForSession(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  status: string = 'session-ended',
  key?: ContinuityKey,
): number {
  return sqliteSyncStore(handlesOf(hippoRoot)).sessions.closeSessionSnapshots(tenantId, sessionId, status, key ?? null);
}

export function listSessionEvents(
  hippoRoot: string,
  tenantId: string,
  options: { session_id?: string; task?: string; limit?: number } = {},
): SessionEvent[] {
  return onHandle(hippoRoot, (db) => listSessionEventsAt(db, tenantId, options), openStore);
}

export function findPromotableSessions(
  hippoRoot: string,
  tenantId: string,
  sinceMs: number,
): Array<{ session_id: string }> {
  return onHandle(hippoRoot, (db) => findPromotableSessionsAt(db, tenantId, sinceMs), openStore);
}

export function wmPush(
  hippoRoot: string,
  opts: {
    scope: string;
    content: string;
    importance?: number;
    sessionId?: string;
    taskId?: string;
    metadata?: JsonObject;
    tenantId?: string;
  },
): number {
  return sqliteSyncStore(handlesOf(hippoRoot)).sessions.pushWorkingMemory(opts.tenantId ?? resolveTenantId({}), opts);
}

export function wmRead(
  hippoRoot: string,
  opts?: {
    scope?: string;
    sessionId?: string;
    limit?: number;
    tenantId?: string;
  },
): WorkingMemoryItem[] {
  return sqliteSyncStore(handlesOf(hippoRoot)).sessions.readWorkingMemory(
    opts?.tenantId ?? resolveTenantId({}),
    opts ?? {},
  );
}

export function wmClear(
  hippoRoot: string,
  opts?: {
    scope?: string;
    sessionId?: string;
    tenantId?: string;
  },
): number {
  return sqliteSyncStore(handlesOf(hippoRoot)).sessions.clearWorkingMemory(
    opts?.tenantId ?? resolveTenantId({}),
    opts ?? {},
  );
}

export function updateStats(hippoRoot: string, delta: Parameters<typeof updateStatsAt>[2]): void {
  onHandle(hippoRoot, (db) => updateStatsAt(db, { hippoRoot }, delta), openStore);
}
