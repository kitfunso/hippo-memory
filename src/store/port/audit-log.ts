import type { AuditOp } from '../../base/records/audit-ops.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT } from '../../base/util/limits.js';
import type { AuditEvent } from './types.js';

/** The rows an audit list reads for `limit`: one past the cap, since GET /v1/audit reads a row ahead to tell whether
 * another page exists. */
export const auditRowsRead = (limit: number | undefined): number =>
  Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT + 1));

/** The read behind the audit list. It writes no audit row. */
export interface AuditLog {
  /** One tenant's rows newest first, by ts then id descending, narrowed by `op` and by `since` (ts at or after it);
   * `limit` reads auditRowsRead rows, and `after` resumes below the (ts, id) position a page ended
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
