// The in-memory AuditLog group: the tenant's audit rows, filtered, ordered and paged as hippo.db's query does.
import { auditRowsRead, type AuditLog, type QueryAuditOptions } from '../port/audit-log.js';
import type { AuditEvent } from '../port/types.js';
import { byBytes, isBelow, newestFirst, type DescendingKeyset } from '../rules/order.js';
import type { MemoryTables } from './tables.js';

const WALK: DescendingKeyset<AuditEvent> = { key: (row) => row.ts, intId: (row) => row.id };

function listIn(t: MemoryTables, { tenantId, op, since, limit, after }: QueryAuditOptions): AuditEvent[] {
  const rows = t.audit
    .filter((row) => row.tenantId === tenantId && (!op || row.op === op) && (!since || byBytes(row.ts, since) >= 0))
    .filter((row) => !after || isBelow(WALK, row, after))
    .sort(newestFirst(WALK));
  return structuredClone(rows.slice(0, auditRowsRead(limit)));
}

export function memoryAuditLog(t: MemoryTables): AuditLog {
  return { listAuditEvents: async (query) => listIn(t, query) };
}
