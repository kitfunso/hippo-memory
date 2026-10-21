// The in-memory Quarantine group: the review records beside the memories they hold back, decided as the port says.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type {
  Quarantine,
  QuarantineApproval,
  QuarantineListQuery,
  QuarantineRefusal,
  QuarantineRow,
  QuarantinedMemory,
} from '../port/quarantine.js';
import { isBelow, newestFirst, type DescendingKeyset } from '../rules/order.js';
import { QUARANTINE_LIST_LIMIT } from '../port/quarantine.js';
import { appendAudit } from './rows.js';
import type { MemoryTables } from './tables.js';

const WALK: DescendingKeyset<QuarantineRow> = { key: (row) => row.quarantinedAt, textId: (row) => row.memoryId };

function owned(t: MemoryTables, tenantId: string, id: string): MemoryEntry | undefined {
  const entry = t.entries.get(id);
  return entry?.tenantId === tenantId ? entry : undefined;
}

function pendingOrRefusal(t: MemoryTables, tenantId: string, id: string): QuarantineRow | QuarantineRefusal {
  const row = t.quarantine.find((r) => r.tenantId === tenantId && r.memoryId === id);
  if (!row) return { outcome: 'not_quarantined' };
  return row.status === 'pending' ? row : { outcome: 'already_decided', status: row.status };
}

function decide(t: MemoryTables, row: QuarantineRow, status: 'approved' | 'rejected', actor: string): void {
  const decided = { ...row, status, decidedAt: new Date().toISOString(), decidedBy: actor };
  t.quarantine[t.quarantine.indexOf(row)] = decided;
}

function listIn(t: MemoryTables, tenantId: string, { status, limit, after }: QuarantineListQuery): QuarantinedMemory[] {
  const hits = t.quarantine.filter(
    (row) =>
      row.tenantId === tenantId &&
      (status === 'all' || row.status === status) &&
      (status !== 'pending' || owned(t, tenantId, row.memoryId) !== undefined) &&
      (!after || isBelow(WALK, row, after)),
  );
  const page = hits.sort(newestFirst(WALK)).slice(0, limit ?? QUARANTINE_LIST_LIMIT);
  const withContent = (row: QuarantineRow): QuarantinedMemory => ({
    ...row,
    content: owned(t, tenantId, row.memoryId)?.content ?? null,
  });
  return structuredClone(page.map(withContent));
}

function approveIn(t: MemoryTables, tenantId: string, id: string, actor: string): QuarantineApproval {
  const row = pendingOrRefusal(t, tenantId, id);
  if ('outcome' in row) return row;
  const memory = owned(t, tenantId, id);
  if (!memory || memory.scope !== `quarantine:private:${row.originalScope ?? 'unscoped'}`) {
    return { outcome: 'scope_moved' };
  }
  // The audit row goes in first: if it is refused, neither change below has happened, as one transaction would have it.
  const metadata = { originalScope: row.originalScope };
  appendAudit(t, [{ tenantId, actor, op: 'quarantine_approve', targetId: id, metadata }]);
  t.entries.set(id, { ...memory, scope: row.originalScope });
  decide(t, row, 'approved', actor);
  return { outcome: 'approved' };
}

export function memoryQuarantine(t: MemoryTables): Quarantine {
  return {
    listQuarantined: async (tenantId, query) => listIn(t, tenantId, query),
    approveQuarantined: async (tenantId, id, actor) => approveIn(t, tenantId, id, actor),
    async rejectQuarantined(tenantId, id, actor) {
      const row = pendingOrRefusal(t, tenantId, id);
      if ('outcome' in row) return row;
      appendAudit(t, [{ tenantId, actor, op: 'quarantine_reject', targetId: id, metadata: {} }]);
      decide(t, row, 'rejected', actor);
      return { outcome: 'rejected' };
    },
  };
}
