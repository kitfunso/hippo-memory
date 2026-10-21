// The in-memory task snapshots and session events, with the continuity key that scopes the snapshots and handoffs.
import { freshActiveSnapshot } from '../../base/session/session-snapshot.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import type { SessionEvent, SessionEventInput, SnapshotInput, TaskSnapshot, Sessions } from '../port/sessions.js';
import { continuityStamp, type ContinuityKey } from '../port/types.js';
import { newestFirst } from '../rules/order.js';
import { nextId, storedObject } from './rows.js';
import type { Owned, Tenanted } from './session-tables.js';
import type { MemoryTables } from './tables.js';

const DEFAULT_EVENT_LIMIT = 8;

/** As hippo.db's continuityWhere: all or nothing, so a key missing its owner or every project name matches no row. */
export function keyMatches(key: ContinuityKey | null | undefined, row: Owned<unknown>): boolean {
  if (!key) return true;
  const names = key.project.filter((n) => n !== '');
  if (key.owner === '' || names.length === 0) return false;
  return row.owner === key.owner && row.origin !== null && names.includes(row.origin);
}

/** The columns a keyed write stamps; a partial key throws before anything changes. */
export function stampOf(key: ContinuityKey | null | undefined): { owner: string | null; origin: string | null } {
  return key ? continuityStamp(key) : { owner: null, origin: null };
}

/** Newest first by `updatedAt`, then the larger id. */
const newestSnapshot = newestFirst<Owned<TaskSnapshot>>({ key: (s) => s.row.updatedAt, intId: (s) => s.row.id });

function activeIn(t: MemoryTables, tenantId: string, key: ContinuityKey | null | undefined): Owned<TaskSnapshot>[] {
  const active = t.snapshots.filter((s) => s.tenantId === tenantId && s.row.status === 'active' && keyMatches(key, s));
  return active.sort(newestSnapshot);
}

export function loadSnapshotIn(t: MemoryTables, tenantId: string, key: ContinuityKey | null | undefined) {
  const newest = activeIn(t, tenantId, key)[0];
  return newest ? { ...newest.row } : null;
}

function saveSnapshotIn(t: MemoryTables, tenantId: string, input: SnapshotInput, key: ContinuityKey | null) {
  const stamp = stampOf(key);
  const now = new Date().toISOString();
  for (const s of activeIn(t, tenantId, key)) s.row = { ...s.row, status: 'superseded', updatedAt: now };
  const row: TaskSnapshot = {
    id: nextId(t, 'task_snapshots'),
    task: redactSecretsStrict(input.task),
    summary: redactSecretsStrict(input.summary),
    nextStep: redactSecretsStrict(input.nextStep),
    status: 'active',
    source: input.source ?? 'cli',
    sessionId: input.sessionId ?? null,
    scope: input.scope ?? null,
    createdAt: now,
    updatedAt: now,
  };
  t.snapshots.push({ tenantId, row, ...stamp });
  return { ...row };
}

/** The tenant's newest active snapshot, whoever saved it, closed with `status`. */
function clearIn(t: MemoryTables, tenantId: string, status: string): boolean {
  const newest = activeIn(t, tenantId, null)[0];
  if (!newest) return false;
  newest.row = { ...newest.row, status, updatedAt: new Date().toISOString() };
  return true;
}

// The session id is matched too, so an ending session never closes a newer session's snapshot.
function closeIn(t: MemoryTables, tenantId: string, sessionId: string, status: string, key: ContinuityKey | null) {
  if (key) continuityStamp(key);
  const now = new Date().toISOString();
  const closing = activeIn(t, tenantId, key).filter((s) => s.row.sessionId === sessionId);
  for (const s of closing) s.row = { ...s.row, status, updatedAt: now };
  return closing.length;
}

function appendEventIn(t: MemoryTables, tenantId: string, input: SessionEventInput): SessionEvent {
  const id = nextId(t, 'session_events');
  const row: SessionEvent = {
    id,
    sessionId: input.sessionId,
    task: input.task ?? null,
    eventType: input.eventType,
    content: input.content,
    source: input.source ?? 'cli',
    scope: input.scope ?? null,
    metadata: storedObject(JSON.stringify(input.metadata ?? {}), {
      table: 'session_events',
      id,
      column: 'metadata_json',
    }),
    createdAt: new Date().toISOString(),
  };
  t.events.push({ tenantId, row });
  return structuredClone(row);
}

const newestEvent = newestFirst<Tenanted<SessionEvent>>({ key: (e) => e.row.createdAt, intId: (e) => e.row.id });

/** The `limit` newest events a non-empty session id and task narrow, returned oldest first. */
export function listEventsIn(
  t: MemoryTables,
  tenantId: string,
  opts: { readonly sessionId?: string; readonly task?: string; readonly limit?: number },
): SessionEvent[] {
  const { sessionId, task } = opts;
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_EVENT_LIMIT));
  const events = t.events.filter(
    (e) => e.tenantId === tenantId && (!sessionId || e.row.sessionId === sessionId) && (!task || e.row.task === task),
  );
  return structuredClone(
    events
      .sort(newestEvent)
      .slice(0, limit)
      .reverse()
      .map((e) => e.row),
  );
}

/** The content of the session's newest `session_complete` event, read for the handoff's outcome. */
export function sessionCompletion(t: MemoryTables, tenantId: string, sessionId: string): string | undefined {
  const done = t.events.filter(
    (e) => e.tenantId === tenantId && e.row.sessionId === sessionId && e.row.eventType === 'session_complete',
  );
  return done.sort(newestEvent)[0]?.row.content;
}

type SnapshotMethods = Pick<
  Sessions,
  | 'saveSnapshot'
  | 'loadSnapshot'
  | 'loadFreshSnapshot'
  | 'clearSnapshot'
  | 'closeSessionSnapshots'
  | 'appendEvent'
  | 'listEvents'
>;

export function memorySnapshots(t: MemoryTables): SnapshotMethods {
  return {
    saveSnapshot: async (tenantId, snapshot, key) => saveSnapshotIn(t, tenantId, snapshot, key),
    loadSnapshot: async (tenantId, key) => loadSnapshotIn(t, tenantId, key),
    loadFreshSnapshot: async (tenantId, opts, key) => freshActiveSnapshot(loadSnapshotIn(t, tenantId, key), opts),
    clearSnapshot: async (tenantId, clearedStatus) => clearIn(t, tenantId, clearedStatus),
    closeSessionSnapshots: async (tenantId, sessionId, status, key) => closeIn(t, tenantId, sessionId, status, key),
    appendEvent: async (tenantId, event) => appendEventIn(t, tenantId, event),
    listEvents: async (tenantId, opts) => listEventsIn(t, tenantId, opts),
  };
}
