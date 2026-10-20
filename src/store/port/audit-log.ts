import type { AuditOp } from '../../core/audit-ops.js';
import type { KeysetPosition } from '../../util/keyset.js';
import type { AuditEvent } from './types.js';

/** The read behind the audit list. It writes no audit row. */
export interface AuditLog {
  /** One tenant's rows newest first, by ts then id descending, narrowed by `op` and by `since` (ts at or after it);
   * `limit` is clamped to 1..10001 and defaults to 100, and `after` resumes below the (ts, id) position a page ended
   * on. */
  listAuditEvents(query: QueryAuditOptions): Promise<AuditEvent[]>;
}

export interface QueryAuditOptions {
  tenantId: string;
  op?: AuditOp;
  since?: string; // ISO timestamp
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}
