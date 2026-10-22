// The in-memory Dormant group: memories set aside whole, listed, restored through the memory write or forgotten.
import { reviveDormant } from '../../base/memory/dormant-revival.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { fromWire, toWire } from '../../base/memory/memory-wire.js';
import { ownScopeTouches } from '../../base/scope/recall-scope.js';
import { DAY_MS } from '../../base/util/time.js';
import {
  dormantListCap,
  dormantTerms,
  type DormantMemory,
  type DormantRestoreOutcome,
  type ListDormantOpts,
} from '../port/dormant.js';
import type { Dormant, DormantRestoreRequest } from '../port/dormant.js';
import type { DormantSnapshot } from '../port/types.js';
import { comparing, DORMANT_ORDER } from '../rules/order.js';
import { appendAudit, asciiFolded, bumpCounter, tenantKey } from './rows.js';
import { put, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

/** Sets `entry` aside in the form a dormant row keeps: the entry as its wire JSON reads back. */
export function setAside(t: MemoryTables, snapshot: DormantSnapshot): void {
  const entry = fromWire(JSON.parse(JSON.stringify(toWire(snapshot.entry))));
  t.dormant.set(tenantKey(entry.tenantId, entry.id), { ...snapshot, entry });
}

/** The tenant's snapshot `id` when `ownScope` may touch its scope. */
function inReach(t: MemoryTables, tenantId: string, ownScope: string | null, id: string): DormantSnapshot | undefined {
  const snapshot = t.dormant.get(tenantKey(tenantId, id));
  return snapshot && ownScopeTouches(ownScope, snapshot.entry.scope ?? null) ? snapshot : undefined;
}

function listedAs({ entry, reason, strength, dormantAt }: DormantSnapshot): DormantMemory {
  const { id, tenantId, content } = entry;
  return { id, tenantId, content, tags: entry.tags.map(String), strength, reason, dormantAt };
}

function listIn(t: MemoryTables, tenantId: string, ownScope: string | null, opts: ListDormantOpts): DormantMemory[] {
  const terms = dormantTerms(opts).map(asciiFolded);
  const hits = [...t.dormant.values()].filter(
    (s) =>
      s.entry.tenantId === tenantId &&
      ownScopeTouches(ownScope, s.entry.scope ?? null) &&
      terms.every((term) => asciiFolded(s.entry.content).includes(term)),
  );
  hits.sort(comparing(DORMANT_ORDER));
  return hits.slice(0, dormantListCap(opts)).map(listedAs);
}

function restoreIn(t: MemoryTables, tenantId: string, request: DormantRestoreRequest): DormantRestoreOutcome {
  const snapshot = inReach(t, tenantId, request.ownScope, request.id);
  if (!snapshot) return { status: 'missing' };
  if (t.entries.has(request.id)) return { status: 'active' };
  const now = new Date();
  const entry: MemoryEntry = reviveDormant(snapshot, now, request.revival);
  stage(t, request.actor, (tx) => {
    put(t, tx, entry, request.actor);
    const metadata = {
      reason: snapshot.reason,
      strengthAtDormancy: snapshot.strength,
      dormantAt: snapshot.dormantAt,
      daysDormant: Math.max(0, (now.getTime() - Date.parse(snapshot.dormantAt)) / DAY_MS),
    };
    tx.audit.push({ tenantId, actor: request.actor, op: 'dormant_restore', targetId: request.id, metadata });
  });
  t.dormant.delete(tenantKey(tenantId, request.id));
  return { status: 'restored', entry: structuredClone(entry) };
}

export function memoryDormant(t: MemoryTables): Dormant {
  return {
    list: async (tenantId, ownScope, opts) => listIn(t, tenantId, ownScope, opts),
    holds: async (tenantId, ownScope, id) => inReach(t, tenantId, ownScope, id) !== undefined,
    restore: async (tenantId, request) => restoreIn(t, tenantId, request),
    async forget(tenantId, ownScope, id, actor) {
      if (!inReach(t, tenantId, ownScope, id)) return false;
      t.dormant.delete(tenantKey(tenantId, id));
      appendAudit(t, [{ tenantId, actor, op: 'forget', targetId: id, metadata: { dormant: true } }]);
      bumpCounter(t, 'total_forgotten', 1);
      return true;
    },
  };
}
