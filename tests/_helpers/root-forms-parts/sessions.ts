// Root-keyed sessions forms tests call; production code goes through the port or the handle-first forms.

import type { HandoffOutcome, SessionHandoff } from '../../../src/base/session/handoff.js';
import { resolveTenantId } from '../../../src/surface/server/boot.js';
import type {
  HandoffFilter,
  SessionEndHandoffRequest,
  SessionEvent,
  SessionEventInput,
  SnapshotInput,
  TaskSnapshot,
  WorkingMemoryItem,
} from '../../../src/base/ports/store/sessions.js';
import * as handoffsSql from '../../../src/store/sqlite/handoffs.js';
import * as indexAndStatsSql from '../../../src/store/sqlite/index-and-stats.js';
import { readLastRecall } from '../../../src/store/sqlite/mirrors.js';
import { openStore } from '../../../src/store/sqlite/handles.js';
import type { StoreFiles } from '../../../src/store/sqlite/open.js';
import type { HippoIndex } from '../../../src/store/sqlite/rows.js';
import * as sessionsSql from '../../../src/store/sqlite/sessions.js';
import type { UntracedSession } from '../../../src/base/ports/store/consolidation.js';
import * as taskSnapshotsSql from '../../../src/store/sqlite/task-snapshots.js';
import { freshActiveSnapshot } from '../../../src/base/session/session-snapshot.js';
import type { ContinuityKey } from '../../../src/base/ports/store/types.js';
import type { JsonObject } from '../../../src/base/util/json.js';
import { sessionDecayContext } from '../../../src/domain/consolidate/decay.js';
import { onHandle, sqliteStore, storeFilesOf } from '../test-session.js';

export function saveActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  snapshot: SnapshotInput,
  key?: ContinuityKey,
): TaskSnapshot {
  return onHandle(
    hippoRoot,
    (db) => taskSnapshotsSql.saveActiveTaskSnapshot(db, storeFilesOf(hippoRoot), tenantId, snapshot, key),
    openStore,
  );
}

export function appendSessionEvent(
  hippoRoot: string,
  tenantId: string,
  event: SessionEventInput,
): Promise<SessionEvent> {
  return sqliteStore(hippoRoot).sessions.save(tenantId, 'event', event);
}

export function saveSessionHandoff(
  hippoRoot: string,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
  key?: ContinuityKey,
): SessionHandoff {
  return onHandle(hippoRoot, (db) => handoffsSql.saveSessionHandoff(db, tenantId, handoff, key), openStore);
}

export function loadLatestHandoff(
  hippoRoot: string,
  tenantId: string,
  sessionId?: string,
  opts: HandoffFilter = {},
  key?: ContinuityKey,
): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => handoffsSql.readLatestHandoff(db, tenantId, sessionId, opts, key), openStore);
}

export function loadHandoffById(hippoRoot: string, tenantId: string, id: number): SessionHandoff | null {
  return onHandle(hippoRoot, (db) => handoffsSql.readHandoff(db, tenantId, id), openStore);
}

export function stampHandoffOutcome(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  outcome: HandoffOutcome,
): number {
  return onHandle(hippoRoot, (db) => handoffsSql.stampHandoffOutcome(db, tenantId, sessionId, outcome), openStore);
}

export function writeSessionEndHandoff(
  hippoRoot: string,
  request: SessionEndHandoffRequest & { readonly tenantId: string; readonly key?: ContinuityKey },
): SessionHandoff | null {
  const files = storeFilesOf(hippoRoot);
  const { tenantId, key } = request;
  return onHandle(hippoRoot, (db) => handoffsSql.writeSessionEndHandoff(db, files, tenantId, request, key), openStore);
}

export function loadLastRecall(hippoRoot: string): Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'> {
  return onHandle(hippoRoot, (db) => readLastRecall(db), openStore);
}

export function saveIndex(hippoRoot: string, index: Pick<HippoIndex, 'last_retrieval_ids' | 'last_trace_id'>): void {
  return onHandle(hippoRoot, (db) => indexAndStatsSql.saveIndex(db, index), openStore);
}

/** `files` carries the runtime and lock wait of the caller's store. */
export function updateStatsUnlessBusy(
  files: StoreFiles,
  delta: Parameters<typeof indexAndStatsSql.updateStatsUnlessBusy>[2],
  committed: string,
): void {
  onHandle(
    files.hippoRoot,
    (db) => indexAndStatsSql.updateStatsUnlessBusy(db, files, delta, committed),
    (root) => openStore(root, files.opens),
  );
}

export function appendConsolidationRun(
  hippoRoot: string,
  run: { timestamp: string; decayed: number; merged: number; removed: number },
): void {
  onHandle(hippoRoot, (db) => indexAndStatsSql.appendConsolidationRun(db, storeFilesOf(hippoRoot), run), openStore);
}

export function loadSessionDecayContext(hippoRoot: string): ReturnType<typeof sessionDecayContext> {
  return sessionDecayContext(onHandle(hippoRoot, (db) => indexAndStatsSql.readSleepHistory(db), openStore));
}

export function loadActiveTaskSnapshot(hippoRoot: string, tenantId: string, key?: ContinuityKey): TaskSnapshot | null {
  return onHandle(
    hippoRoot,
    (db) => taskSnapshotsSql.readActiveTaskSnapshot(db, storeFilesOf(hippoRoot), tenantId, key),
    openStore,
  );
}

export function loadFreshActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  opts: { maxAgeMs?: number; sessionId?: string | null } = {},
  key?: ContinuityKey,
): TaskSnapshot | null {
  return freshActiveSnapshot(loadActiveTaskSnapshot(hippoRoot, tenantId, key), opts);
}

export async function clearActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  clearedStatus: string = 'cleared',
): Promise<boolean> {
  return (await sqliteStore(hippoRoot).sessions.clear(tenantId, 'snapshot', { status: clearedStatus })) > 0;
}

export async function closeTaskSnapshotsForSession(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  status: string = 'session-ended',
  key?: ContinuityKey,
): Promise<number> {
  return await sqliteStore(hippoRoot).sessions.clear(tenantId, 'snapshot', { status, sessionId }, key ?? null);
}

export function listSessionEvents(
  hippoRoot: string,
  tenantId: string,
  options: { session_id?: string; task?: string; limit?: number } = {},
): SessionEvent[] {
  return onHandle(hippoRoot, (db) => sessionsSql.listSessionEvents(db, tenantId, options), openStore);
}

export function findUntracedSessions(hippoRoot: string, tenantId: string, sinceMs: number): UntracedSession[] {
  return onHandle(hippoRoot, (db) => sessionsSql.listUntracedSessions(db, tenantId, sinceMs), openStore);
}

export async function wmPush(
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
): Promise<number> {
  return await sqliteStore(hippoRoot).sessions.save(opts.tenantId ?? resolveTenantId({}), 'working_memory', opts);
}

export async function wmRead(
  hippoRoot: string,
  opts?: {
    scope?: string;
    sessionId?: string;
    limit?: number;
    tenantId?: string;
  },
): Promise<WorkingMemoryItem[]> {
  const tenantId = opts?.tenantId ?? resolveTenantId({});
  return await sqliteStore(hippoRoot).sessions.read(tenantId, 'working_memory', opts ?? {});
}

export async function wmClear(
  hippoRoot: string,
  opts?: {
    scope?: string;
    sessionId?: string;
    tenantId?: string;
  },
): Promise<number> {
  return await sqliteStore(hippoRoot).sessions.clear(
    opts?.tenantId ?? resolveTenantId({}),
    'working_memory',
    opts ?? {},
  );
}

export function updateStats(hippoRoot: string, delta: Parameters<typeof indexAndStatsSql.updateStats>[2]): void {
  onHandle(hippoRoot, (db) => indexAndStatsSql.updateStats(db, storeFilesOf(hippoRoot), delta), openStore);
}
