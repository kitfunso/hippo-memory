// The in-memory Sessions group: snapshots, events and handoffs from their own files, with working memory and the
// session-owner binding here.
import type { Sessions, WorkingMemoryFilter, WorkingMemoryPush, WorkingMemoryItem } from '../port/sessions.js';
import { handoffByIdIn, latestHandoffIn, saveHandoffIn, stampOutcomeIn, writeSessionEndIn } from './handoffs.js';
import { byBytes } from '../rules/order.js';
import { WM_MAX_ENTRIES } from '../rules/windows.js';
import { nextId, storedObject, tenantKey } from './rows.js';
import type { Tenanted } from './session-tables.js';
import { memorySnapshots } from './snapshots.js';
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

function readIn(t: MemoryTables, tenantId: string, filter: WorkingMemoryFilter & { readonly limit?: number }) {
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

export function memorySessions(t: MemoryTables): Sessions {
  return {
    ...memorySnapshots(t),
    saveHandoff: async (tenantId, handoff, key) => saveHandoffIn(t, tenantId, handoff, key),
    latestHandoff: async (tenantId, sessionId, filter, key) => latestHandoffIn(t, tenantId, sessionId, filter, key),
    handoffById: async (tenantId, id) => handoffByIdIn(t, tenantId, id),
    stampHandoffOutcome: async (tenantId, sessionId, outcome) => stampOutcomeIn(t, tenantId, sessionId, outcome),
    writeSessionEndHandoff: async (tenantId, request) => writeSessionEndIn(t, tenantId, request),
    pushWorkingMemory: async (tenantId, item) => pushIn(t, tenantId, item),
    readWorkingMemory: async (tenantId, filter) => readIn(t, tenantId, filter),
    clearWorkingMemory: async (tenantId, filter) => clearIn(t, tenantId, filter),
    bindSessionOwner: async (tenantId, sessionId, owner, retentionMs) =>
      bindOwnerIn(t, tenantId, sessionId, owner, retentionMs),
  };
}
