// The in-memory Sessions group: snapshots, events and handoffs from their own files, with working memory and the
// session-owner binding here.
import { freshActiveSnapshot } from '../../base/session/session-snapshot.js';
import type {
  SessionCalls,
  SessionClearArgs,
  SessionReadArgs,
  Sessions,
  SessionSaveArgs,
  WorkingMemoryFilter,
  WorkingMemoryPush,
  WorkingMemoryItem,
} from '../../base/ports/store/sessions.js';
import { handoffByIdIn, latestHandoffIn, saveHandoffIn, stampOutcomeIn, writeSessionEndIn } from './handoffs.js';
import { byBytes } from '../rules/order.js';
import { WM_MAX_ENTRIES } from '../rules/windows.js';
import { nextId, storedObject, tenantKey } from './rows.js';
import type { Tenanted } from './session-tables.js';
import {
  appendEventIn,
  clearSnapshotIn,
  closeSnapshotsIn,
  listEventsIn,
  readSnapshotIn,
  saveSnapshotIn,
} from './snapshots.js';
import type { MemoryTables } from './tables.js';

/** Past WM_MAX_ENTRIES in the scope, the lowest importance goes first, then the oldest by created_at and id. */
function evictOverCapacity(t: MemoryTables, tenantId: string, scope: string): void {
  const inScope = t.workingMemory.filter((w) => w.tenantId === tenantId && w.row.scope === scope);
  const excess = inScope.length - WM_MAX_ENTRIES;
  if (excess <= 0) return;
  const order = (a: Tenanted<WorkingMemoryItem>, b: Tenanted<WorkingMemoryItem>): number =>
    a.row.importance - b.row.importance || byBytes(a.row.createdAt, b.row.createdAt) || a.row.id - b.row.id;
  const evicted = new Set(inScope.sort(order).slice(0, excess));
  t.workingMemory = t.workingMemory.filter((w) => !evicted.has(w));
}

function pushIn(t: MemoryTables, tenantId: string, item: WorkingMemoryPush): number {
  const now = new Date().toISOString();
  const id = nextId(t, 'working_memory');
  const row: WorkingMemoryItem = {
    id,
    scope: item.scope,
    sessionId: item.sessionId ?? null,
    taskId: item.taskId ?? null,
    importance: Number(item.importance ?? 0),
    content: item.content,
    createdAt: now,
    updatedAt: now,
    metadata: storedObject(JSON.stringify(item.metadata ?? {}), {
      table: 'working_memory',
      id,
      column: 'metadata_json',
    }),
  };
  t.workingMemory.push({ tenantId, row });
  evictOverCapacity(t, tenantId, item.scope);
  return id;
}

/** The tenant's items a non-empty scope and session id narrow. */
function matcher(tenantId: string, { scope, sessionId }: WorkingMemoryFilter) {
  return (w: Tenanted<WorkingMemoryItem>): boolean =>
    w.tenantId === tenantId && (!scope || w.row.scope === scope) && (!sessionId || w.row.sessionId === sessionId);
}

function listWorkingMemoryIn(
  t: MemoryTables,
  tenantId: string,
  filter: WorkingMemoryFilter & { readonly limit?: number },
) {
  const limit = Math.max(1, Math.trunc(filter.limit ?? WM_MAX_ENTRIES));
  const items = t.workingMemory.filter(matcher(tenantId, filter));
  items.sort(
    (a, b) => b.row.importance - a.row.importance || byBytes(b.row.createdAt, a.row.createdAt) || b.row.id - a.row.id,
  );
  return structuredClone(items.slice(0, limit).map((w) => w.row));
}

function clearIn(t: MemoryTables, tenantId: string, filter: WorkingMemoryFilter): number {
  const before = t.workingMemory.length;
  const cleared = matcher(tenantId, filter);
  t.workingMemory = t.workingMemory.filter((w) => !cleared(w));
  return before - t.workingMemory.length;
}

/** The stored owner, binding `owner` first when none is; a first bind prunes every binding past `retentionMs`. */
function bindOwnerIn(t: MemoryTables, tenantId: string, sessionId: string, owner: string, retentionMs: number) {
  const slot = tenantKey(tenantId, sessionId);
  const bound = t.sessionOwners.get(slot);
  if (bound) return bound.owner;
  t.sessionOwners.set(slot, { owner, createdAt: new Date().toISOString() });
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  for (const [key, binding] of t.sessionOwners) {
    if (byBytes(binding.createdAt, cutoff) < 0) t.sessionOwners.delete(key);
  }
  return t.sessionOwners.get(slot)?.owner ?? null;
}

function saveAnyIn(t: MemoryTables, ...[tenantId, kind, row, key = null]: SessionSaveArgs) {
  if (kind === 'snapshot') return saveSnapshotIn(t, tenantId, row, key);
  if (kind === 'event') return appendEventIn(t, tenantId, row);
  if (kind === 'working_memory') return pushIn(t, tenantId, row);
  if ('handoff' in row) return saveHandoffIn(t, tenantId, row.handoff, key);
  if ('sessionEnd' in row) return writeSessionEndIn(t, tenantId, row.sessionEnd, key);
  return stampOutcomeIn(t, tenantId, row.sessionId, row.outcome);
}

function readAnyIn(t: MemoryTables, ...[tenantId, kind, query, key = null]: SessionReadArgs) {
  if (kind === 'event') return listEventsIn(t, tenantId, query);
  if (kind === 'working_memory') return listWorkingMemoryIn(t, tenantId, query);
  if ('id' in query) return handoffByIdIn(t, tenantId, query.id);
  return latestHandoffIn(t, tenantId, query.sessionId, query, key);
}

function clearAnyIn(t: MemoryTables, ...[tenantId, kind, close, key]: SessionClearArgs) {
  if (kind === 'working_memory') return clearIn(t, tenantId, close);
  if (close.sessionId === undefined) return clearSnapshotIn(t, tenantId, close.status);
  return closeSnapshotsIn(t, tenantId, close.sessionId, close.status, key);
}

export function memorySessions(t: MemoryTables): Sessions {
  const sessions: SessionCalls = {
    save: async (...args) => saveAnyIn(t, ...args),
    read: async (...args) => readAnyIn(t, ...args),
    clear: async (...args) => clearAnyIn(t, ...args),
    async loadSnapshot(tenantId, { ambient }, key) {
      const active = readSnapshotIn(t, tenantId, key);
      return ambient ? freshActiveSnapshot(active, ambient) : active;
    },
    bindSessionOwner: async (tenantId, sessionId, owner, retentionMs) =>
      bindOwnerIn(t, tenantId, sessionId, owner, retentionMs),
  };
  // SAFETY: each body picks its rows from the kind and the payload's shape, the pairs the port's overloads name, so
  // every overload gets the answer its kind declares.
  return sessions as Sessions;
}
