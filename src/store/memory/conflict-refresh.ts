// A sleep's conflict refresh over plain tables, as hippo.db's replaceDetectedConflicts runs it: stale open conflicts
// resolve, detected ones open, and each member's conflictsWith lists its open partners; a pair across tenants never.
import type { DetectedConflict } from '../../base/ports/store/consolidation.js';
import { nextId } from './rows.js';
import { stage } from './staged.js';
import type { MemoryTables } from './tables.js';

const pairKey = (a: string, b: string): string => `${a}::${b}`;

/** The pair in one order, so a and b detected either way round name the same row. */
function canonical(c: DetectedConflict) {
  const [a, b] = c.memory_a_id < c.memory_b_id ? [c.memory_a_id, c.memory_b_id] : [c.memory_b_id, c.memory_a_id];
  return { a, b, reason: c.reason, score: c.score };
}

function upsertDetected(t: MemoryTables, detected: ReturnType<typeof canonical>[], at: string, same: SameTenant) {
  for (const c of detected) {
    if (!same(c.a, c.b)) continue;
    const i = t.conflicts.findIndex((row) => row.memoryAId === c.a && row.memoryBId === c.b);
    const fields = { reason: c.reason, score: c.score, status: 'open', updatedAt: at };
    if (i >= 0) {
      t.conflicts[i] = { ...t.conflicts[i]!, ...fields };
    } else {
      t.conflicts.push({
        id: nextId(t, 'memory_conflicts'),
        memoryAId: c.a,
        memoryBId: c.b,
        detectedAt: at,
        ...fields,
      });
    }
  }
}

type SameTenant = (a: string, b: string) => boolean;

/** Rewrites each memory whose open partners changed, sorted as hippo.db stores them. */
function rebuildConflictsWith(t: MemoryTables, same: SameTenant): void {
  const refs = new Map<string, Set<string>>();
  for (const c of t.conflicts) {
    if (c.status !== 'open' || !same(c.memoryAId, c.memoryBId)) continue;
    refs.set(c.memoryAId, (refs.get(c.memoryAId) ?? new Set()).add(c.memoryBId));
    refs.set(c.memoryBId, (refs.get(c.memoryBId) ?? new Set()).add(c.memoryAId));
  }
  stage(t, 'sleep', (tx) => {
    const holding = [...tx.rows.values()].filter((e) => e.conflictsWith.length > 0).map((e) => e.id);
    for (const id of new Set([...holding, ...refs.keys()])) {
      const row = tx.rows.get(id);
      const next = [...(refs.get(id) ?? [])].sort();
      if (row && JSON.stringify(row.conflictsWith) !== JSON.stringify(next)) {
        tx.rows.set(id, { ...row, conflictsWith: next });
      }
    }
  });
}

export function replaceConflictsIn(t: MemoryTables, conflicts: readonly DetectedConflict[], at: string): void {
  const tenantOf = (id: string): string | undefined => t.entries.get(id)?.tenantId;
  const same: SameTenant = (a, b) => tenantOf(a) !== undefined && tenantOf(a) === tenantOf(b);
  const detected = conflicts.map(canonical);
  const keys = new Set(detected.map((c) => pairKey(c.a, c.b)));
  t.conflicts.forEach((c, i) => {
    if (c.status === 'open' && (!keys.has(pairKey(c.memoryAId, c.memoryBId)) || !same(c.memoryAId, c.memoryBId))) {
      t.conflicts[i] = { ...c, status: 'resolved', updatedAt: at };
    }
  });
  upsertDetected(t, detected, at, same);
  rebuildConflictsWith(t, same);
}
