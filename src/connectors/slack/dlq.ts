import type { DatabaseSyncLike } from '../../db.js';

export interface DlqItem {
  id: number;
  tenantId: string;
  rawPayload: string;
  error: string;
  receivedAt: string;
  retriedAt: string | null;
}

export interface WriteDlqOpts {
  tenantId: string;
  rawPayload: string;
  error: string;
}

export function writeToDlq(db: DatabaseSyncLike, opts: WriteDlqOpts): number {
  const result = db
    .prepare(`INSERT INTO slack_dlq (tenant_id, raw_payload, error, received_at) VALUES (?, ?, ?, ?)`)
    .run(opts.tenantId, opts.rawPayload, opts.error, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function listDlq(db: DatabaseSyncLike, opts: { tenantId: string; limit?: number }): DlqItem[] {
  const rows = db
    .prepare(`SELECT id, tenant_id, raw_payload, error, received_at, retried_at FROM slack_dlq WHERE tenant_id = ? ORDER BY received_at ASC LIMIT ?`)
    .all(opts.tenantId, opts.limit ?? 100) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    tenantId: String(r.tenant_id),
    rawPayload: String(r.raw_payload),
    error: String(r.error),
    receivedAt: String(r.received_at),
    retriedAt: r.retried_at == null ? null : String(r.retried_at),
  }));
}

export function markDlqRetried(db: DatabaseSyncLike, id: number): void {
  db.prepare(`UPDATE slack_dlq SET retried_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}
