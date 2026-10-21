// Every audit row hippo.db holds, in id order and read as the store reads one, so a test can compare whole audit logs.
import type { DatabaseSyncLike } from '../../src/db/index.js';
import type { AuditOp } from '../../src/base/records/audit-ops.js';
import { parseStoredObject } from '../../src/base/util/stored-json.js';
import { ALL_TENANTS, type TenantId } from '../../src/base/util/tenant.js';
import type { AuditEvent } from '../../src/store/port/types.js';

interface AuditRow {
  id: number;
  ts: string;
  tenant_id: string;
  actor: string;
  op: string;
  target_id: string | null;
  metadata_json: string;
}

/** The audit rows of `tenantId`, or of every tenant, oldest id first. */
export function auditRowsOn(db: DatabaseSyncLike, tenantId: TenantId = ALL_TENANTS): AuditEvent[] {
  const where = tenantId === ALL_TENANTS ? '' : ' WHERE tenant_id = ?';
  const sql = `SELECT id, ts, tenant_id, actor, op, target_id, metadata_json FROM audit_log${where} ORDER BY id`;
  // SAFETY: the SELECT names every AuditRow column.
  const rows = db.prepare(sql).all(...(tenantId === ALL_TENANTS ? [] : [tenantId])) as AuditRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    tenantId: r.tenant_id,
    actor: r.actor,
    // SAFETY: appendAuditEvent writes op only from AuditOp.
    op: r.op as AuditOp,
    targetId: r.target_id,
    metadata: parseStoredObject({ table: 'audit_log', id: r.id, column: 'metadata_json' }, r.metadata_json) ?? {},
  }));
}
