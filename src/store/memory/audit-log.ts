// The in-memory AuditLog group: the tenant's audit rows, filtered, ordered and paged as hippo.db's query does.
import { DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT } from '../../base/util/limits.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import type { AuditLog, QueryAuditOptions } from '../port/audit-log.js';
import type { AuditEvent } from '../port/types.js';
import { byBytes } from './rows.js';
import type { MemoryTables } from './tables.js';

const newestFirst = (a: AuditEvent, b: AuditEvent): number => byBytes(b.ts, a.ts) || b.id - a.id;

function isBelow(row: AuditEvent, after: KeysetPosition): boolean {
  const byTs = byBytes(row.ts, String(after.key));
  return byTs < 0 || (byTs === 0 && row.id < Number(after.id));
}

function listIn(t: MemoryTables, { tenantId, op, since, limit, after }: QueryAuditOptions): AuditEvent[] {
  const rows = t.audit
    .filter((row) => row.tenantId === tenantId && (!op || row.op === op) && (!since || byBytes(row.ts, since) >= 0))
    .filter((row) => !after || isBelow(row, after))
    .sort(newestFirst);
  // One past the cap: GET /v1/audit reads a row ahead to tell whether another page exists.
  return structuredClone(rows.slice(0, Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT + 1))));
}

export function memoryAuditLog(t: MemoryTables): AuditLog {
  return { listAuditEvents: async (query) => listIn(t, query) };
}
